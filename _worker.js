// _worker.js

// Docker镜像仓库主机地址（默认值，不可变）
const DEFAULT_HUB_HOST = 'registry-1.docker.io';
// Docker认证服务器地址
const auth_url = 'https://auth.docker.io';

// 允许通过 ?ns= 指定的上游（fail-closed 白名单）
const UPSTREAM_HOSTS = new Set([
	'docker.io',
	'registry-1.docker.io',
	'quay.io',
	'gcr.io',
	'k8s.gcr.io',
	'registry.k8s.io',
	'ghcr.io',
	'docker.cloudsmith.io',
	'nvcr.io',
	'registry.gitlab.com',
	'public.ecr.aws',
	'mcr.microsoft.com',
]);

// 允许跨域暴露的响应头（显式白名单，替代 expose-headers: *）
// 搜索缓存版本：改变搜索结果结构/来源时递增，强制换 key，避免命中旧结构缓存
const SEARCH_CACHE_VER = 'v3';

const EXPOSE_HEADERS = 'Docker-Content-Digest, Docker-Upload-UUID, Link, Location, Range, Www-Authenticate, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset';

// 自有 HTML 页面的响应头（含 CSP）
const HTML_HEADERS = {
	'Content-Type': 'text/html; charset=UTF-8',
	"content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src * data:; connect-src 'self' https://hub.docker.com",
};
/**
 * 归一化两种搜索源的返回结构：
 *  - index.docker.io/v1/search：{ name, description, star_count, pull_count, is_official, is_automated }
 *  - hub.docker.com/v2/search：{ repo_name, short_description, star_count, pull_count, ... }
 * 统一成前端渲染需要的字段。
 */
function normalizeSearchResults(data) {
	const list = (data && (data.results || data.data)) || null;
	if (!Array.isArray(list)) return null;
	return list.map(function (r) {
		const name = r.repo_name || r.name || '';
		return {
			repo_name: name,
			name: name,
			short_description: r.short_description || r.description || '',
			star_count: r.star_count || 0,
			pull_count: r.pull_count || 0,
			is_official: !!r.is_official,
			is_automated: !!r.is_automated
		};
	});
}

/**
 * Docker Hub 凭证优先级：客户端自带 Authorization > Worker 配置的账号（env.DOCKERHUB_USER/TOKEN）> 匿名。
 * 匿名拉取按出口 IP 计 100 次/6h，Cloudflare 共享 IP 极易打满，所以优先用账号额度（200 次/6h）。
 * @returns {string|null} 可直接放进 Authorization 头的值
 */
function dockerAuthHeader(request, env) {
	const fromClient = request.headers.get('Authorization');
	if (fromClient) return fromClient;
	if (env && env.DOCKERHUB_USER && env.DOCKERHUB_TOKEN) {
		return 'Basic ' + btoa(env.DOCKERHUB_USER + ':' + env.DOCKERHUB_TOKEN);
	}
	return null;
}




// 根据主机名选择对应的上游地址
function routeByHosts(host) {
	// 定义路由表
	const routes = {
		// 生产环境
		"quay": "quay.io",
		"gcr": "gcr.io",
		"k8s-gcr": "k8s.gcr.io",
		"k8s": "registry.k8s.io",
		"ghcr": "ghcr.io",
		"cloudsmith": "docker.cloudsmith.io",
		"nvcr": "nvcr.io",
		"gitlab": "registry.gitlab.com",
		"ecr": "public.ecr.aws",
		"mcr": "mcr.microsoft.com",

		// 测试环境
		"test": "registry-1.docker.io",
	};

	if (host in routes) return [routes[host], false];
	else return [DEFAULT_HUB_HOST, true];
}

/** @type {RequestInit} */
const PREFLIGHT_INIT = {
	// 预检请求配置
	headers: new Headers({
		'access-control-allow-origin': '*', // 允许所有来源
		'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS', // 允许的HTTP方法
		'access-control-allow-headers': 'Authorization, Content-Type, Accept, Range, If-None-Match, X-Amz-Content-Sha256',
		'access-control-max-age': '1728000', // 预检请求的缓存时间
	}),
}

/**
 * 构造响应
 * @param {any} body 响应体
 * @param {number} status 响应状态码
 * @param {Object<string, string>} headers 响应头
 */
function makeRes(body, status = 200, headers = {}) {
	headers['access-control-allow-origin'] = '*' // 允许所有来源
	return new Response(body, { status, headers }) // 返回新构造的响应
}

/**
 * 构造新的URL对象
 * @param {string} urlStr URL字符串
 * @param {string} base URL base
 */
function newUrl(urlStr, base) {
	try {
		console.log(`Constructing new URL object with path ${urlStr} and base ${base}`);
		return new URL(urlStr, base); // 尝试构造新的URL对象
	} catch (err) {
		console.error(err);
		return null // 构造失败返回null
	}
}

async function nginx() {
	const text = `
	<!DOCTYPE html>
	<html>
	<head>
	<title>Welcome to nginx!</title>
	<style>
		body {
			width: 35em;
			margin: 0 auto;
			font-family: Tahoma, Verdana, Arial, sans-serif;
		}
	</style>
	</head>
	<body>
	<h1>Welcome to nginx!</h1>
	<p>If you see this page, the nginx web server is successfully installed and
	working. Further configuration is required.</p>
	
	<p>For online documentation and support please refer to
	<a href="http://nginx.org/">nginx.org</a>.<br/>
	Commercial support is available at
	<a href="http://nginx.com/">nginx.com</a>.</p>
	
	<p><em>Thank you for using nginx.</em></p>
	</body>
	</html>
	`
	return text;
}

// [Search fix] 搜索页面 — 前端 JS 直接调用 Docker Hub API（不经过 Worker 代理）
// 用户浏览器 IP 不会被 Docker Hub 限流
async function searchInterface(workers_url) {
	const rawHost = workers_url.replace(/^https:\/\//, '');
	const mirrorHost = /^[a-z0-9.-]+(:\d+)?$/i.test(rawHost) ? rawHost : 'localhost';
	const html = `
	<!DOCTYPE html>
	<html>
	<head>
		<title>Docker Hub 镜像搜索</title>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<style>
		:root {
			--github-color: rgb(27,86,198);
			--github-bg-color: #ffffff;
			--primary-color: #0066ff;
			--primary-dark: #0052cc;
			--gradient-start: #1a90ff;
			--gradient-end: #003eb3;
			--text-color: #ffffff;
			--shadow-color: rgba(0,0,0,0.1);
			--transition-time: 0.3s;
		}
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
			display: flex; flex-direction: column; align-items: center;
			min-height: 100vh; margin: 0;
			background: linear-gradient(135deg, var(--gradient-start) 0%, var(--gradient-end) 100%);
			padding: 0; color: var(--text-color); overflow-x: hidden;
		}
		/* 顶部搜索栏（结果模式下显示） */
		.top-bar {
			display: none; width: 100%; background: rgba(0,0,0,0.15);
			padding: 14px 20px; align-items: center; gap: 12px; flex-wrap: wrap;
		}
		.top-bar.show { display: flex; }
		.top-bar a.back { color: #fff; text-decoration: none; font-weight: 600; font-size: 1.1em; }
		.top-bar .search-form {
			display: flex; flex: 1; min-width: 200px; max-width: 500px;
			height: 40px; border-radius: 8px; overflow: hidden;
			box-shadow: 0 2px 8px rgba(0,0,0,0.15);
		}
		.top-bar .search-form input { flex: 1; border: none; outline: none; padding: 0 14px; font-size: 15px; }
		.top-bar .search-form button {
			width: 50px; background: var(--primary-color); border: none;
			cursor: pointer; color: #fff; font-size: 18px;
		}
		.top-bar .search-form button:hover { background: var(--primary-dark); }
		/* 首页居中容器 */
		.container {
			text-align: center; width: 100%; max-width: 800px; padding: 20px;
			margin: 0 auto; display: flex; flex-direction: column;
			justify-content: center; min-height: 60vh; animation: fadeIn 0.8s ease-out;
		}
		.container.hide { display: none; }
		@keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
		.github-corner { position: fixed; top: 0; right: 0; z-index: 999; transition: transform var(--transition-time) ease; }
		.github-corner:hover { transform: scale(1.08); }
		.github-corner svg {
			fill: var(--github-bg-color); color: var(--github-color);
			position: absolute; top: 0; border: 0; right: 0; width: 80px; height: 80px;
			filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.2));
		}
		.logo { margin-bottom: 20px; transition: transform var(--transition-time) ease; animation: float 6s ease-in-out infinite; }
		@keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
		.logo:hover { transform: scale(1.08) rotate(5deg); }
		.logo svg { filter: drop-shadow(0 5px 15px rgba(0, 0, 0, 0.2)); }
		.title { color: var(--text-color); font-size: 2.3em; margin-bottom: 10px; text-shadow: 0 2px 10px rgba(0, 0, 0, 0.2); font-weight: 700; letter-spacing: -0.5px; }
		.subtitle { color: rgba(255,255,255,0.9); font-size: 1.1em; margin-bottom: 25px; max-width: 600px; margin-left: auto; margin-right: auto; line-height: 1.4; }
		.search-container {
			display: flex; align-items: stretch; width: 100%; max-width: 600px;
			margin: 0 auto; height: 55px; position: relative;
			box-shadow: 0 10px 25px rgba(0,0,0,0.15); border-radius: 12px; overflow: hidden;
		}
		#search-input { flex: 1; padding: 0 20px; font-size: 16px; border: none; outline: none; height: 100%; }
		#search-input:focus { padding-left: 25px; }
		#search-button {
			width: 60px; background-color: var(--primary-color); border: none; cursor: pointer;
			height: 100%; display: flex; align-items: center; justify-content: center;
		}
		#search-button svg { transition: transform 0.3s ease; stroke: white; }
		#search-button:hover { background-color: var(--primary-dark); }
		#search-button:hover svg { transform: translateX(2px); }
		.tips { color: rgba(255,255,255,0.8); margin-top: 20px; font-size: 0.9em; }
		/* 结果区域 */
		.results-info { color: rgba(255,255,255,0.9); padding: 10px 20px 0; font-size: 0.95em; display: none; }
		.results-info.show { display: block; }
		.results-container { max-width: 900px; width: 100%; margin: 16px auto; padding: 0 16px 30px; }
		.result-card {
			background: #fff; border-radius: 10px; padding: 18px 20px; margin-bottom: 12px;
			box-shadow: 0 2px 10px rgba(0,0,0,0.08); transition: transform 0.15s, box-shadow 0.15s;
		}
		.result-card:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.12); }
		.card-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.card-title { font-size: 1.15em; font-weight: 700; color: var(--primary-color); text-decoration: none; }
		.card-title:hover { text-decoration: underline; }
		.badges { display: flex; gap: 6px; }
		.badge { font-size: 0.75em; padding: 2px 8px; border-radius: 4px; font-weight: 600; color: #fff; }
		.badge.official { background: #0b6abf; }
		.badge.automated { background: #6c757d; }
		.card-desc { color: #555; margin: 8px 0; font-size: 0.95em; line-height: 1.4; }
		.card-meta { display: flex; gap: 18px; font-size: 0.88em; color: #777; margin-bottom: 8px; }
		.card-pull { background: #f5f7fa; border-radius: 6px; padding: 8px 12px; overflow-x: auto; }
		.card-pull code { font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.88em; color: #333; white-space: nowrap; }
		.no-results, .error-msg, .loading-msg {
			background: rgba(255,255,255,0.15); color: #fff; padding: 40px 20px;
			text-align: center; border-radius: 10px; font-size: 1.1em;
		}
		@media (max-width: 768px) { .container { padding: 20px 15px; } .title { font-size: 2em; } .search-container { height: 50px; } }
		@media (max-width: 480px) { .github-corner svg { width: 60px; height: 60px; } .search-container { height: 45px; } #search-input { padding: 0 15px; } #search-button { width: 50px; } .title { font-size: 1.7em; } }
		</style>
	</head>
	<body>
		<!-- 顶部搜索栏（搜索结果模式） -->
		<div class="top-bar" id="top-bar">
			<a href="/" class="back">&#9664; Docker Hub 镜像搜索</a>
			<div class="search-form">
				<input type="text" id="top-search-input" placeholder="搜索镜像...">
				<button id="top-search-button">&#128269;</button>
			</div>
		</div>
		<div class="results-info" id="results-info"></div>

		<a href="https://github.com/cmliu/CF-Workers-docker.io" target="_blank" class="github-corner" aria-label="View source on Github">
			<svg viewBox="0 0 250 250" aria-hidden="true">
				<path d="M0,0 L115,115 L130,115 L142,142 L250,250 L250,0 Z"></path>
				<path d="M128.3,109.0 C113.8,99.7 119.0,89.6 119.0,89.6 C122.0,82.7 120.5,78.6 120.5,78.6 C119.2,72.0 123.4,76.3 123.4,76.3 C127.3,80.9 125.5,87.3 125.5,87.3 C122.9,97.6 130.6,101.9 134.4,103.2" fill="currentColor" style="transform-origin: 130px 106px;" class="octo-arm"></path>
				<path d="M115.0,115.0 C114.9,115.1 118.7,116.5 119.8,115.4 L133.7,101.6 C136.9,99.2 139.9,98.4 142.2,98.6 C133.8,88.0 127.5,74.4 143.8,58.0 C148.5,53.4 154.0,51.2 159.7,51.0 C160.3,49.4 163.2,43.6 171.4,40.1 C171.4,40.1 176.1,42.5 178.8,56.2 C183.1,58.6 187.2,61.8 190.9,65.4 C194.5,69.0 197.7,73.2 200.1,77.6 C213.8,80.2 216.3,84.9 216.3,84.9 C212.7,93.1 206.9,96.0 205.4,96.6 C205.1,102.4 203.0,107.8 198.3,112.5 C181.9,128.9 168.3,122.5 157.7,114.1 C157.9,116.9 156.7,120.9 152.7,124.9 L141.0,136.5 C139.8,137.7 141.6,141.9 141.8,141.8 Z" fill="currentColor" class="octo-body"></path>
			</svg>
		</a>
		<!-- 首页 -->
		<div class="container" id="home-container">
			<div class="logo">
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 18" fill="#ffffff" width="110" height="85">
					<path d="M23.763 6.886c-.065-.053-.673-.512-1.954-.512-.32 0-.659.03-1.01.087-.248-1.703-1.651-2.533-1.716-2.57l-.345-.2-.227.328a4.596 4.596 0 0 0-.611 1.433c-.23.972-.09 1.884.403 2.666-.596.331-1.546.418-1.744.42H.752a.753.753 0 0 0-.75.749c-.007 1.456.233 2.864.692 4.07.545 1.43 1.355 2.483 2.409 3.13 1.181.725 3.104 1.14 5.276 1.14 1.016 0 2.03-.092 2.93-.266 1.417-.273 2.705-.742 3.826-1.391a10.497 10.497 0 0 0 2.61-2.14c1.252-1.42 1.998-3.005 2.553-4.408.075.003.148.005.221.005 1.371 0 2.215-.55 2.68-1.01.505-.5.685-.998.704-1.053L24 7.076l-.237-.19Z"></path>
					<path d="M2.216 8.075h2.119a.186.186 0 0 0 .185-.186V6a.186.186 0 0 0-.185-.186H2.216A.186.186 0 0 0 2.031 6v1.89c0 .103.083.186.185.186Zm2.92 0h2.118a.185.185 0 0 0 .185-.186V6a.185.185 0 0 0-.185-.186H5.136A.185.185 0 0 0 4.95 6v1.89c0 .103.083.186.186.186Zm2.964 0h2.118a.186.186 0 0 0 .185-.186V6a.186.186 0 0 0-.185-.186H8.1A.185.185 0 0 0 7.914 6v1.89c0 .103.083.186.186.186Zm2.928 0h2.119a.185.185 0 0 0 .185-.186V6a.185.185 0 0 0-.185-.186h-2.119a.186.186 0 0 0-.185.186v1.89c0 .103.083.186.185.186Zm-5.892-2.72h2.118a.185.185 0 0 0 .185-.186V3.28a.186.186 0 0 0-.185-.186H5.136a.186.186 0 0 0-.186.186v1.89c0 .103.083.186.186.186Zm2.964 0h2.118a.186.186 0 0 0 .185-.186V3.28a.186.186 0 0 0-.185-.186H8.1a.186.186 0 0 0-.186.186v1.89c0 .103.083.186.186.186Zm2.928 0h2.119a.185.185 0 0 0 .185-.186V3.28a.186.186 0 0 0-.185-.186h-2.119a.186.186 0 0 0-.185.186v1.89c0 .103.083.186.185.186Zm0-2.72h2.119a.186.186 0 0 0 .185-.186V.56a.185.185 0 0 0-.185-.186h-2.119a.186.186 0 0 0-.185.186v1.89c0 .103.083.186.185.186Zm2.955 5.44h2.118a.185.185 0 0 0 .186-.186V6a.185.185 0 0 0-.186-.186h-2.118a.185.185 0 0 0-.185.186v1.89c0 .103.083.186.185.186Z"></path>
				</svg>
			</div>
			<h1 class="title">Docker Hub 镜像搜索</h1>
			<p class="subtitle">快速查找、下载和部署 Docker 容器镜像</p>
			<div class="search-container">
				<input type="text" id="search-input" placeholder="输入关键词搜索镜像，如: nginx, mysql, redis...">
				<button id="search-button" title="搜索">
					<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
						<path d="M13 5l7 7-7 7M5 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round"></path>
					</svg>
				</button>
			</div>
			<p class="tips">基于 Cloudflare Workers / Pages 构建，利用全球边缘网络实现毫秒级响应。</p>
		</div>
		<!-- 搜索结果 -->
		<div class="results-container" id="results-container"></div>

		<script>
		const MIRROR_HOST = ${JSON.stringify(mirrorHost)};

		// 内置常用镜像清单：Docker Hub 搜索接口被限流时用它兜底，保证搜索页永远可用
		const HOT_IMAGES = [
			'nginx|高性能 Web 服务器与反向代理',
			'redis|内存键值数据库',
			'mysql|关系型数据库',
			'mariadb|MySQL 兼容分支',
			'postgres|PostgreSQL 数据库',
			'mongo|MongoDB 文档数据库',
			'node|Node.js 运行时',
			'python|Python 运行时',
			'golang|Go 编译环境',
			'openjdk|Java 运行环境',
			'php|PHP + Apache',
			'ruby|Ruby 运行时',
			'alpine|最小 Linux 基础镜像',
			'ubuntu|Ubuntu 基础镜像',
			'debian|Debian 基础镜像',
			'centos|CentOS 基础镜像',
			'busybox|超小工具集',
			'httpd|Apache HTTP 服务器',
			'tomcat|Java Servlet 容器',
			'rabbitmq|消息队列',
			'kafka|分布式消息流平台',
			'zookeeper|分布式协调服务',
			'nacos|服务注册与配置中心',
			'rocketmq|消息中间件',
			'elasticsearch|搜索与分析引擎',
			'kibana|Elasticsearch 可视化',
			'logstash|日志采集管道',
			'grafana|监控可视化面板',
			'prometheus|监控与告警',
			'influxdb|时序数据库',
			'jenkins|持续集成',
			'sonarqube|代码质量分析',
			'minio|S3 兼容对象存储',
			'consul|服务发现与配置',
			'vault|密钥管理',
			'traefik|云原生反向代理',
			'kong|API 网关',
			'envoy|服务代理',
			'memcached|内存缓存',
			'etcd|分布式键值存储',
			'clickhouse|列式分析数据库',
			'tidb|分布式 MySQL 兼容数据库',
			'emqx|MQTT 消息服务器',
			'mosquitto|轻量 MQTT broker',
			'registry|私有镜像仓库',
			'portainer|Docker 图形管理',
			'adminer|数据库 Web 客户端',
			'wordpress|博客与 CMS',
			'nextcloud|私有云盘',
			'hello-world|测试镜像',
		];

		function escHtml(s) { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }

		function fmtPulls(n) {
			if (!n) return '0';
			if (n >= 1e9) return (n/1e9).toFixed(1)+'B';
			if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
			if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
			return String(n);
		}

		function renderResults(results, query) {
			var info = document.getElementById('results-info');
			var container = document.getElementById('results-container');
			info.classList.add('show');
			if (!results || results.length === 0) {
				info.innerHTML = '';
				container.innerHTML = '<div class="no-results">没有找到与 "<strong>'+escHtml(query)+'</strong>" 相关的镜像</div>';
				return;
			}
			info.innerHTML = '找到 '+results.length+' 个与 "<strong>'+escHtml(query)+'</strong>" 相关的镜像';
			container.innerHTML = results.map(function(r) {
				var name = escHtml(r.repo_name || r.name || '');
				var desc = escHtml(r.short_description || '');
				var stars = r.star_count || 0;
				var pulls = fmtPulls(r.pull_count);
				var official = r.is_official ? '<span class="badge official">Official</span>' : '';
				var automated = r.is_automated ? '<span class="badge automated">Automated</span>' : '';
				var pullName = (r.repo_name || r.name || '').indexOf('/') >= 0 ? (r.repo_name || r.name) : 'library/'+(r.repo_name || r.name);
				var pullCmd = 'docker pull '+MIRROR_HOST+'/'+pullName;
				var hubUrl = (r.repo_name || r.name || '').indexOf('/') >= 0
					? 'https://hub.docker.com/r/'+name
					: 'https://hub.docker.com/_/'+name;
				return '<div class="result-card">'
					+'<div class="card-header">'
					+'<a href="'+hubUrl+'" target="_blank" class="card-title">'+name+'</a>'
					+'<div class="badges">'+official+automated+'</div>'
					+'</div>'
					+'<p class="card-desc">'+(desc||'<em>暂无描述</em>')+'</p>'
					+'<div class="card-meta"><span title="Stars">&#11088; '+stars+'</span><span title="Pulls">&#128229; '+pulls+'</span></div>'
					+'<div class="card-pull"><code>'+escHtml(pullCmd)+'</code></div>'
					+'</div>';
			}).join('');
		}

			function localSearch(query) {
				var q = String(query || '').toLowerCase();
				if (!q) return [];
				var hits = [];
				for (var i = 0; i < HOT_IMAGES.length; i++) {
					var parts = HOT_IMAGES[i].split('|');
					if (parts[0].indexOf(q) >= 0 || parts[1].toLowerCase().indexOf(q) >= 0) {
						hits.push({ repo_name: parts[0], short_description: parts[1], local: true });
					}
				}
				return hits;
			}

		function doSearch(query) {
			if (!query) return;
			// 切换到结果模式
			document.getElementById('home-container').classList.add('hide');
			document.getElementById('top-bar').classList.add('show');
			document.getElementById('top-search-input').value = query;
			document.getElementById('results-container').innerHTML = '<div class="loading-msg">正在搜索 "'+escHtml(query)+'" ...</div>';
			document.getElementById('results-info').classList.add('show');
			document.getElementById('results-info').innerHTML = '';
			// 更新 URL（不刷新页面）
			history.replaceState(null, '', '/search?q='+encodeURIComponent(query));
			// 两级降级：同源 /api/search（Worker 侧走 index.docker.io，带边缘缓存）→ 内置常用镜像清单
			var finished = false;
			function degrade(reason) {
				if (finished) return;
				finished = true;
				var local = localSearch(query);
				renderResults(local, query);
				document.getElementById('results-info').innerHTML = 'Docker Hub 搜索暂时不可用（' + escHtml(reason) + '），以下为内置常用镜像，可直接 pull：';
				if (!local.length) {
					document.getElementById('results-container').innerHTML = '<div class="no-results">没有匹配的内置镜像<br><br>直接试试：<br><code>docker pull ' + escHtml(MIRROR_HOST) + '/library/' + escHtml(query) + '</code></div>';
				}
			}
			fetch('/api/search?q=' + encodeURIComponent(query))
				.then(function(resp) { return resp.json(); })
				.then(function(json) {
					if (finished) return;
					if (json && json.results && json.results.length) {
						finished = true;
						renderResults(json.results, query);
						return;
					}
					degrade(json && json.reason === 'rate_limited' ? '上游限流 429，请稍后再试' : '接口暂时不可用');
				})
				.catch(function() { degrade('网络不可达'); });
		}

		// 首页搜索
		function performSearch() {
			var q = document.getElementById('search-input').value.replace('library/','').trim();
			if (q) doSearch(q);
		}
		document.getElementById('search-button').addEventListener('click', performSearch);
		document.getElementById('search-input').addEventListener('keypress', function(e) { if (e.key==='Enter') performSearch(); });
		// 顶部搜索栏
		document.getElementById('top-search-button').addEventListener('click', function() {
			var q = document.getElementById('top-search-input').value.replace('library/','').trim();
			if (q) doSearch(q);
		});
		document.getElementById('top-search-input').addEventListener('keypress', function(e) {
			if (e.key==='Enter') {
				var q = document.getElementById('top-search-input').value.replace('library/','').trim();
				if (q) doSearch(q);
			}
		});
		// 页面加载时检查 URL 参数，如果有 q 则自动搜索
		window.addEventListener('load', function() {
			var params = new URLSearchParams(window.location.search);
			var q = params.get('q');
			if (q) {
				doSearch(q.replace('library/','').trim());
			} else {
				document.getElementById('search-input').focus();
			}
		});
		</script>
	</body>
	</html>
	`;
	return html;
}

export default {
	async fetch(request, env, ctx) {
		const getReqHeader = (key) => request.headers.get(key); // 获取请求头

		let url = new URL(request.url); // 解析请求URL
		// 归一重复斜杠：/v2//library/nginx/... 会被上游当成不同仓库名而 401
		if (url.pathname.indexOf('//') >= 0) url.pathname = url.pathname.replace(/\/{2,}/g, '/');

		// 预检请求必须在 UA/页面分支之前处理，否则浏览器 UA 会拿到 302 而不是 CORS 头
		if (request.method === 'OPTIONS') return new Response(null, PREFLIGHT_INIT);

		// 内部缓存命名空间不对外暴露
		if (url.pathname.indexOf('/__blob_cache/') === 0) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });

		const userAgentHeader = request.headers.get('User-Agent');
		const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : "null";
		// 请求级 UA 黑名单；过滤空串，避免 env.UA 为空白时 includes('') 对所有 UA 恒真
		const uaBlacklist = ['netcraft'];
		if (env.UA) uaBlacklist.push(...(await ADD(env.UA)).filter(function (s) { return s.trim().length > 0; }));

		// 同源搜索接口：优先走 index.docker.io/v1/search（实测不被 Worker 出口 IP 限流），
		// hub.docker.com/v2/search 仅作后备（该接口对 CF 共享出口 IP 限流很严）
		if (url.pathname === '/api/search') {
			if (uaBlacklist.length > 0 && uaBlacklist.some(function (f) { return userAgent.includes(f); })) return makeRes('blocked', 403);
			const q = (url.searchParams.get('q') || '').trim().slice(0, 128);
			const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };
			if (!q) return new Response(JSON.stringify({ results: [], degraded: true, reason: 'empty_query' }), { status: 200, headers: jsonHeaders });

			// 命中边缘缓存直接返回
			const cacheKey = new Request('https://search-cache.internal/?ver=' + SEARCH_CACHE_VER + '&q=' + encodeURIComponent(q.toLowerCase()));
			let cache = null;
			try { cache = caches.default; } catch (e) { cache = null; }
			if (cache) {
				const hit = await cache.match(cacheKey);
				if (hit) return hit;
			}

			const sources = [
				'https://index.docker.io/v1/search?q=' + encodeURIComponent(q) + '&n=25',
				'https://hub.docker.com/v2/search/repositories/?query=' + encodeURIComponent(q) + '&page_size=25',
			];
			let results = null;
			let searchOk = false;
			let lastReason = 'upstream_unreachable';
			let sawEmpty = false; // 有源返回 200 但 0 命中：比 429 更准确的归因
			let saw429 = false;
			for (const src of sources) {
				let upstream = null;
				try {
					upstream = await fetch(src, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; docker-mirror)' } });
				} catch (e) {
					lastReason = 'upstream_unreachable';
					continue;
				}
				if (!upstream.ok) {
					if (upstream.status === 429) saw429 = true;
					lastReason = upstream.status === 429 ? 'rate_limited' : 'upstream_' + upstream.status;
					continue;
				}
				let data = null;
				try { data = await upstream.json(); } catch (e) { lastReason = 'bad_json'; continue; }
				const norm = normalizeSearchResults(data);
				if (norm && norm.length) { results = norm; searchOk = true; break; }
				sawEmpty = true;
				lastReason = 'no_results';
			}

			if (!sawEmpty) { /* 全部源都没有给出「200 但空」的结果 */ }
			if (sawEmpty && saw429) lastReason = 'no_results';
			if (!searchOk || !results) {
				// 全部源都失败：返回降级信号让前端走内置清单，不把错误抛给用户；失败不缓存
				return new Response(JSON.stringify({ results: [], degraded: true, reason: lastReason, retry_after: 60 }), {
					status: 200,
					headers: Object.assign({}, jsonHeaders, { 'cache-control': 'no-store' })
				});
			}

			const res = new Response(JSON.stringify({ results: results, degraded: false }), {
				status: 200,
				headers: Object.assign({}, jsonHeaders, { 'cache-control': 'public, max-age=21600' })
			});
			if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, res.clone()));
			return res;
		}

		const workers_url = `https://${url.hostname}`;

		// 获取请求参数中的 ns
		const ns = (url.searchParams.get('ns') || '').toLowerCase() || null;
		const hostname = (url.searchParams.get('hubhost') || url.hostname).toLowerCase();
		const hostTop = hostname.split('.')[0]; // 获取主机名的第一部分

		// ns 参数白名单校验（fail-closed：非法值直接 400，不再静默回落）
		let hub_host = DEFAULT_HUB_HOST; // [P0 fix] 请求级局部变量，避免并发竞态
		let checkHost; // 在这里定义 checkHost 变量
		if (ns) {
			if (!UPSTREAM_HOSTS.has(ns)) return makeRes('invalid ns', 400);
			hub_host = ns === 'docker.io' ? 'registry-1.docker.io' : ns;
		} else {
			checkHost = routeByHosts(hostTop);
			if (url.searchParams.get('hubhost') && checkHost[1] === true) return makeRes('invalid hubhost', 400);
			hub_host = checkHost[0]; // 获取上游地址
		}

		const fakePage = checkHost ? checkHost[1] : false; // 确保 fakePage 不为 undefined
		// 不把内部路由参数透传给上游
		url.searchParams.delete('ns');
		url.searchParams.delete('hubhost');
		console.log(`域名头部: ${hostTop} 反代地址: ${hub_host} searchInterface: ${fakePage}`);
		// 更改请求的主机名
		url.hostname = hub_host;

		// 处理token请求（严格匹配 + 参数与 scope 白名单，避免被当作通用代理）
		if (url.pathname === '/token' || url.pathname === '/token/') {
			if (request.method !== 'GET' && request.method !== 'HEAD') return makeRes('method not allowed', 405);
			const allowParams = new Set(['service', 'scope', 'account', 'client_id', 'offline_token']);
			for (const k of url.searchParams.keys()) {
				if (!allowParams.has(k)) return makeRes('bad token request', 400);
			}
			const scope = url.searchParams.get('scope') || '';
			if (scope) {
				// 逐个 scope token 做形状校验：允许 pull / push / pull,push / push,pull 与 catalog 列举；多 scope 以空格分隔
				const scopeOk = scope.split(' ').filter(Boolean).every(function (s) {
					return /^(repository:[a-z0-9][a-z0-9._\-\/]*:(pull|push|pull,push|push,pull)|registry:catalog:\*)$/.test(s);
				});
				if (!scopeOk) return makeRes('bad scope', 400);
			}
			if (!scope && !url.searchParams.get('service')) return makeRes('bad token request', 400);
			let token_parameter = {
				headers: {
					'Host': 'auth.docker.io',
					'User-Agent': getReqHeader("User-Agent"),
					'Accept': getReqHeader("Accept"),
					'Accept-Language': getReqHeader("Accept-Language"),
					'Accept-Encoding': getReqHeader("Accept-Encoding"),
					'Connection': 'keep-alive',
					// 同上
				}
			};
			let token_url = auth_url + url.pathname + url.search;
			// 客户端自带 Basic/Bearer 时透传：让每个用户用自己的 Docker Hub 账号换 token，
			// 而不是全部挤在 Worker 的匿名配额上（匿名拉取按 IP 限流，CF 共享 IP 极易打满）
			const clientAuthForToken = request.headers.get('Authorization');
			if (clientAuthForToken) token_parameter.headers['Authorization'] = clientAuthForToken;
			else if (env.DOCKERHUB_USER && env.DOCKERHUB_TOKEN) {
				// 可选：在 Worker 里配一个 Docker Hub 账号（vars/secret），把匿名配额换成账号配额 200 次/6h
				token_parameter.headers['Authorization'] = 'Basic ' + btoa(env.DOCKERHUB_USER + ':' + env.DOCKERHUB_TOKEN);
			}
			// 显式用 GET：把原请求的方法透传上去会让 HEAD 一路打到 auth.docker.io 并拿到 405
			let tokenRes = await fetch(new Request(token_url, { method: 'GET', headers: token_parameter.headers }));
			if (!tokenRes.ok && !clientAuthForToken && token_parameter.headers['Authorization']) {
				// env 账号凭证失效时退回匿名，保证 /token 不会因配置错误而全挂
				delete token_parameter.headers['Authorization'];
				tokenRes = await fetch(new Request(token_url, { method: 'GET', headers: token_parameter.headers }));
			}
			return new Response(tokenRes.body, {
				status: tokenRes.status,
				headers: buildUpstreamHeaders(new URL(token_url), tokenRes, null)
			});
		}
		const hubParams = ['/v1/search', '/v1/repositories'];
		if (uaBlacklist.length > 0 && uaBlacklist.some(fxxk => userAgent.includes(fxxk))) {
			// 首页改成一个nginx伪装页
			return new Response(await nginx(), {
				headers: HTML_HEADERS,
			});
		} else if ((userAgent && userAgent.includes('mozilla')) || hubParams.some(param => url.pathname.includes(param))) {
			if (url.pathname == '/') {
				if (env.URL302) {
					return Response.redirect(env.URL302, 302);
				} else if (env.URL) {
					if (env.URL.toLowerCase() == 'nginx') {
						//首页改成一个nginx伪装页
						return new Response(await nginx(), {
							headers: HTML_HEADERS,
						});
					} else return fetch(new Request(env.URL, request));
				} else	{
					if (fakePage) return new Response(await searchInterface(workers_url), {
						headers: HTML_HEADERS,
					});
				}
			} else {
				// [Search fix] /search 页面由前端 JS 直接调用 Docker Hub API，不经过 Worker
				if (url.pathname === '/search' || url.pathname === '/search/') {
					return new Response(await searchInterface(workers_url), {
						headers: HTML_HEADERS,
					});
				}
				// /v1/ 路径保持原有逻辑（docker CLI search 等）
				if (url.pathname.startsWith('/v1/')) {
					url.hostname = 'index.docker.io';
				} else if (fakePage) {
					// 其他非搜索的浏览器请求，回首页（不再代理 hub.docker.com）
					return Response.redirect(workers_url, 302);
				}
				if (url.searchParams.get('q')?.includes('library/') && url.searchParams.get('q') != 'library/') {
					const search = url.searchParams.get('q');
					url.searchParams.set('q', search.replace('library/', ''));
				}
				const newRequest = new Request(url, request);
				return fetch(newRequest);
			}
		}

		// 修改包含 %2F 和 %3A 的请求
		if (!/%2F/.test(url.search) && /%3A/.test(url.toString())) {
			let modifiedUrl = url.toString().replace(/%3A(?=.*?&)/, '%3Alibrary%2F');
			url = new URL(modifiedUrl);
			console.log(`handle_url: ${url}`);
		}


		// 修改 /v2/ 请求路径
		if (hub_host == 'registry-1.docker.io' && /^\/v2\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname) && !/^\/v2\/library/.test(url.pathname)) {
			//url.pathname = url.pathname.replace(/\/v2\//, '/v2/library/');
			url.pathname = '/v2/library/' + url.pathname.split('/v2/')[1];
			console.log(`modified_url: ${url.pathname}`);
		}

		// 新增：/v2/、/manifests/、/blobs/、/tags/ 先获取token再请求
		if (
			url.pathname.startsWith('/v2/') &&
			(
				url.pathname.includes('/manifests/') ||
				url.pathname.includes('/blobs/') ||
				url.pathname.includes('/tags/')
				|| url.pathname.endsWith('/tags/list')
			)
		) {
			// 提取镜像名
			let repo = '';
			const v2Match = url.pathname.match(/^\/v2\/(.+?)(?:\/(manifests|blobs|tags)\/)/);
			if (v2Match) {
				repo = v2Match[1];
			}
			if (repo) {
				// 凭证优先级：客户端自带 → Docker Hub 直接换 token → 其他上游按自己的 challenge 换 token
				const clientAuth = request.headers.get('Authorization');
				const baseHeaders = {
					'Host': hub_host,
					'User-Agent': getReqHeader("User-Agent"),
					'Accept': getReqHeader("Accept"),
					'Accept-Language': getReqHeader("Accept-Language"),
					'Accept-Encoding': getReqHeader("Accept-Encoding"),
					'Connection': 'keep-alive',
					// 同上
				};
				for (const h of ['Range', 'If-Range', 'If-None-Match']) {
					if (request.headers.has(h)) baseHeaders[h] = getReqHeader(h);
				}
				if (request.headers.has("X-Amz-Content-Sha256")) {
					baseHeaders['X-Amz-Content-Sha256'] = getReqHeader("X-Amz-Content-Sha256");
				}

				const finish = function (res) {
					const hdrs = buildUpstreamHeaders(url, res, workers_url);
					const redirectTo = hdrs.get('Location');
					if (redirectTo) {
						console.info(`Found redirection location, redirecting to ${redirectTo}`);
						return httpHandler(request, redirectTo, hub_host);
					}
					return new Response(res.body, { status: res.status, headers: hdrs });
				};

				// 自管边缘缓存：只对「匿名 GET、无 Range、blob 路径」生效，且**只写 2xx**。
				// 不能用 fetch 的 cf.cacheTtl —— 它会把 401 也按 TTL 缓存，匿名拉取会被 24h 打死。
				const cacheable = !clientAuth && !request.headers.has('Range') && request.method === 'GET' && /\/blobs\//.test(url.pathname);
				let blobCacheKey = null;
				if (cacheable) {
					// Cache API 只允许缓存「自有 zone」的 URL，用外部域名会静默失败；这里用本站域名 + 前缀
					blobCacheKey = new Request(workers_url + '/__blob_cache/' + encodeURIComponent(hub_host + url.pathname));
					try {
						const hit = await caches.default.match(blobCacheKey);
						if (hit) return finish(hit);
					} catch (e) { /* Cache API 不可用则直连 */ }
				}
				// 上游 307 是常态：registry 把 blob 重定向到 CDN（cloudfront / pkg-containers.githubusercontent.com）。
				// 307 不是 2xx，只认 res.ok 会让 hub / ghcr 永远不写缓存；这里自行跟随一次并缓存实体。
				const finishCached = async function (res) {
					if (blobCacheKey && res.status >= 300 && res.status < 400) {
						const loc = res.headers.get('Location');
						if (loc) {
							try {
								const entity = await fetch(loc, { headers: { 'User-Agent': request.headers.get('User-Agent') || '' } });
								if (entity.ok && ctx && ctx.waitUntil) {
									ctx.waitUntil(caches.default.put(blobCacheKey, entity.clone()).catch(function (e) { console.warn('blob cache put failed: ' + (e && e.message)); }));
								}
								return finish(entity);
							} catch (e) { /* 跟随失败则回落到原有重定向处理 */ }
						}
					}
					if (blobCacheKey && res.ok && ctx && ctx.waitUntil) {
						try { ctx.waitUntil(caches.default.put(blobCacheKey, res.clone()).catch(function (e) { console.warn('blob cache put failed: ' + (e && e.message)); })); } catch (e) { /* ignore */ }
					}
					return finish(res);
				};

				let upstreamAuth = clientAuth;
				if (!upstreamAuth && hub_host === 'registry-1.docker.io') {
					// Docker Hub 也走统一的 token 获取（带缓存 + 单飞 + 账号凭证），避免每请求都打 auth.docker.io
					const hubToken = await fetchRegistryToken(auth_url + '/token', 'registry.docker.io', 'repository:' + repo + ':pull', env);
					if (hubToken) upstreamAuth = 'Bearer ' + hubToken;
				} else if (!upstreamAuth) {
					// 其他上游（ghcr/quay/gcr/ecr/nvcr…）：绝不能拿 Docker Hub 的 token，否则上游返回
					// 403 invalid token（ghcr）或 401 Missing kid（quay）。先匿名打一发，按上游自己的
					// Www-Authenticate 去它的 realm 换 token，再重试一次。
					// 关键：probe 不能带 cf 缓存选项。它必然 401，而边缘缓存不按 Authorization 分键，
					// 缓存下来的 401 会被随后带 token 的重试读回，表现为「ghcr blob 匿名下载恒 401」。
					const probe = await fetch(new Request(url, request), { headers: baseHeaders });
					if (probe.status !== 401) return finishCached(probe);
					const challenge = parseBearerChallenge(probe.headers.get('Www-Authenticate'));
					if (challenge) {
						const scope = challenge.scope || ('repository:' + repo + ':pull');
						const token = await fetchRegistryToken(challenge.realm, challenge.service, scope, env);
						if (token) upstreamAuth = 'Bearer ' + token;
					}
					const retryHeaders = Object.assign({}, baseHeaders);
					if (upstreamAuth) retryHeaders['Authorization'] = upstreamAuth;
					let retryRes = await fetch(new Request(url, request), { headers: retryHeaders });
					if (retryRes.status === 401 && !clientAuth && challenge) {
						// 缓存的 token 已被上游判失效：驱逐缓存、重新换一次再试，避免 TTL 内持续 401
						const scope2 = challenge.scope || ('repository:' + repo + ':pull');
						tokenCacheEvict(challenge.realm, challenge.service, scope2);
						const negKey = challenge.realm + '|' + (challenge.service || '') + '|' + scope2;
						if (tokenNegRecent(negKey)) return finishCached(retryRes);
						tokenNegMark(negKey);
						const freshToken = await fetchRegistryToken(challenge.realm, challenge.service, scope2, env);
						if (freshToken) {
							retryHeaders['Authorization'] = 'Bearer ' + freshToken;
							retryRes = await fetch(new Request(url, request), { headers: retryHeaders });
						}
					}
					return finishCached(retryRes);
				}

				const requestHeaders = Object.assign({}, baseHeaders);
				if (upstreamAuth) requestHeaders['Authorization'] = upstreamAuth;

				const upstreamRes = await fetch(new Request(url, request), { headers: requestHeaders });
				return finishCached(upstreamRes);
			}
		}

		// 构造请求参数
		let parameter = {
			headers: {
				'Host': hub_host,
				'User-Agent': getReqHeader("User-Agent"),
				'Accept': getReqHeader("Accept"),
				'Accept-Language': getReqHeader("Accept-Language"),
				'Accept-Encoding': getReqHeader("Accept-Encoding"),
				'Connection': 'keep-alive',
				// 同上
			},
		};

		// 添加Authorization头
		if (request.headers.has("Authorization")) {
			parameter.headers.Authorization = getReqHeader("Authorization");
		}

		// 添加可能存在字段X-Amz-Content-Sha256
		if (request.headers.has("X-Amz-Content-Sha256")) {
			parameter.headers['X-Amz-Content-Sha256'] = getReqHeader("X-Amz-Content-Sha256");
		}

		// 发起请求并处理响应
		let original_response = await fetch(new Request(url, request), parameter);
		const response_headers = buildUpstreamHeaders(url, original_response, workers_url);
		const redirectTo = response_headers.get('Location');
		if (redirectTo) {
			console.info(`Found redirection location, redirecting to ${redirectTo}`);
			return httpHandler(request, redirectTo, hub_host);
		}
		return new Response(original_response.body, {
			status: original_response.status,
			headers: response_headers
		});
	}
};

/**
 * 处理HTTP请求
 * @param {Request} req 请求对象
 * @param {string} pathname 请求路径
 * @param {string} baseHost 基地址
 */
function httpHandler(req, pathname, baseHost) {
	const reqHdrRaw = req.headers;

	// 处理预检请求
	if (req.method === 'OPTIONS' &&
		reqHdrRaw.has('access-control-request-headers')
	) {
		return new Response(null, PREFLIGHT_INIT);
	}

	const reqHdrNew = new Headers(reqHdrRaw);

	reqHdrNew.delete("Authorization"); // 修复s3错误

	const refer = reqHdrNew.get('referer');

	let urlStr = pathname;

	const urlObj = newUrl(urlStr, 'https://' + baseHost);

	/** @type {RequestInit} */
	const reqInit = {
		method: req.method,
		headers: reqHdrNew,
		redirect: 'follow',
		body: req.body
	};
	return proxy(urlObj, reqInit);
}

/**
 * 解析 Www-Authenticate: Bearer realm="...",service="...",scope="..."
 * @returns {{realm: string, service?: string, scope?: string}|null}
 */
function parseBearerChallenge(header) {
	if (!header || !/^bearer\s/i.test(header)) return null;
	const out = {};
	const re = /(\w+)="([^"]*)"/g;
	let m;
	while ((m = re.exec(header))) out[m[1].toLowerCase()] = m[2];
	return out.realm ? out : null;
}

/**
 * 按上游自己的 realm 换 token（ghcr/quay/gcr/ecr 等都走这套标准 OAuth2 流程）。
 * 只有 auth.docker.io 才会带上 Worker 配置的账号凭证。
 * @returns {Promise<string|null>}
 */
// 匿名 token 的内存缓存（isolate 级）：非 Docker Hub 每拉一个 blob 要 3 次回源，缓存能降到 1 次
const TOKEN_CACHE = new Map();
const TOKEN_CACHE_MAX = 200;
// 同一个 token 正在获取时合并并发请求（single-flight），避免 10 并发打 10 次 token 接口
const TOKEN_INFLIGHT = new Map();

function tokenCacheGet(key) {
	const hit = TOKEN_CACHE.get(key);
	if (!hit) return null;
	if (hit.exp <= Date.now() + 5000) { TOKEN_CACHE.delete(key); return null; }
	return hit.token;
}

function tokenCachePut(key, token, ttlSec) {
	if (TOKEN_CACHE.size >= TOKEN_CACHE_MAX) TOKEN_CACHE.delete(TOKEN_CACHE.keys().next().value);
	const ttl = Math.max(30, Math.min(ttlSec || 300, 900));
	TOKEN_CACHE.set(key, { token: token, exp: Date.now() + ttl * 1000 });
}

function tokenCacheEvict(realm, service, scope) {
	try {
		const u = new URL(realm);
		TOKEN_CACHE.delete(u.origin + u.pathname + '|' + (service || '') + '|' + (scope || ''));
	} catch (e) { /* ignore */ }
}

// 上游鉴权故障期的负缓存：30s 内不再重复 evict+重取（否则每次请求会打两次 token 接口）
const TOKEN_NEG = new Map();
function tokenNegMark(key) {
	if (TOKEN_NEG.size > 200) TOKEN_NEG.clear();
	TOKEN_NEG.set(key, Date.now() + 30000);
}
function tokenNegRecent(key) {
	const until = TOKEN_NEG.get(key);
	if (!until) return false;
	if (Date.now() > until) { TOKEN_NEG.delete(key); return false; }
	return true;
}

/**
 * realm 安全校验：只允许 https 的公网主机名。
 * realm 来自上游挑战头，正常是固定字面量；这里做纵深防御，挡住「上游被投毒/被控」时把 Worker 当 SSRF 跳板。
 */
function isSafeRealmHost(host) {
	if (!host) return false;
	if (/^(localhost|\.localhost)$/i.test(host)) return false;
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false; // 直接拒绝 IP 字面量（含内网/环回/元数据地址）
	if (host.indexOf(':') >= 0) return false;                // 拒绝 IPv6 字面量
	return true;
}

/**
 * 按上游自己的 realm 换 token，带内存缓存、realm 校验与 8s 超时。
 * @returns {Promise<string|null>}
 */
async function fetchRegistryToken(realm, service, scope, env) {
	// 单飞：同一 realm+scope 正在取 token 时，后续请求共享同一个 Promise
	const flightKey = realm + '|' + (service || '') + '|' + (scope || '');
	if (TOKEN_INFLIGHT.has(flightKey)) return TOKEN_INFLIGHT.get(flightKey);
	const flight = fetchRegistryTokenInner(realm, service, scope, env).then(
		function (v) { TOKEN_INFLIGHT.delete(flightKey); return v; },
		function (e) { TOKEN_INFLIGHT.delete(flightKey); return null; }
	);
	TOKEN_INFLIGHT.set(flightKey, flight);
	return flight;
}

async function fetchRegistryTokenInner(realm, service, scope, env) {
	let target;
	try { target = new URL(realm); } catch (e) { return null; }
	if (target.protocol !== 'https:' || !isSafeRealmHost(target.hostname)) {
		console.warn('rejected registry realm: ' + target.origin);
		return null;
	}
	if (service) target.searchParams.set('service', service);
	if (scope) target.searchParams.set('scope', scope);

	const cacheKey = target.origin + target.pathname + '|' + (service || '') + '|' + (scope || '');
	const cached = tokenCacheGet(cacheKey);
	if (cached) return cached;

	const headers = { 'Accept': 'application/json' };
	const useAccount = env && env.DOCKERHUB_USER && env.DOCKERHUB_TOKEN && /(^|\.)auth\.docker\.io$/.test(target.hostname);
	if (useAccount) headers['Authorization'] = 'Basic ' + btoa(env.DOCKERHUB_USER + ':' + env.DOCKERHUB_TOKEN);
	function signal() {
		try { return AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined; } catch (e) { return undefined; }
	}
	async function get() {
		const r = await fetch(target.toString(), { headers: headers, signal: signal() });
		if (!r.ok) return null;
		try {
			const j = await r.json();
			const tk = j.token || j.access_token || null;
			return tk ? { token: tk, expires_in: j.expires_in } : null;
		} catch (e) { return null; }
	}
	try {
		let got = await get();
		if (!got && useAccount) {
			delete headers['Authorization'];
			got = await get();
		}
		if (!got) return null;
		tokenCachePut(cacheKey, got.token, got.expires_in);
		return got.token;
	} catch (e) { return null; }
}

/**
 * 统一加工上游响应头：重写 Www-Authenticate、补 CORS 与 expose-headers、按资源类型设 Cache-Control、
 * 清掉上游安全头（registry 响应不是 HTML，自有 HTML 页面的 CSP 由 HTML_HEADERS 设置）。
 * 三条出口（token 分支 / 通用代理分支 / proxy）共用这一个函数，避免响应头逻辑分叉。
 * @param {URL} urlObj 请求 URL（用于按路径决定缓存策略）
 * @param {Response} upstreamRes 上游响应
 * @param {string|null} workersUrl 本站地址，用于重写 Www-Authenticate；传 null 表示不重写
 * @returns {Headers}
 */
function buildUpstreamHeaders(urlObj, upstreamRes, workersUrl) {
	const headers = new Headers(upstreamRes.headers);
	const wwwAuth = headers.get('Www-Authenticate');
	if (wwwAuth && workersUrl) headers.set('Www-Authenticate', wwwAuth.replace(new RegExp(auth_url, 'g'), workersUrl));
	headers.set('access-control-allow-origin', '*');
	headers.set('access-control-expose-headers', EXPOSE_HEADERS);
	headers.set('Cache-Control', cacheControlFor(urlObj, upstreamRes));
	headers.delete('content-security-policy');
	headers.delete('content-security-policy-report-only');
	headers.delete('clear-site-data');
	return headers;
}

// 按响应类型决定 Cache-Control（token 私有、manifest 不缓存、其余可短缓存）
function cacheControlFor(urlObj, res) {
	if (res.status >= 400) return 'no-store'; // 错误响应绝不缓存
	const p = urlObj.pathname || '';
	const ct = (res.headers.get('content-type') || '').toLowerCase();
	if (/\/token/.test(p)) return 'private, no-store';
	if (/\/manifests\//.test(p)) return 'no-store';
	if (/\/tags\//.test(p) || /\/tags\/list$/.test(p)) return 'public, max-age=60';
	if (ct.indexOf('json') >= 0 || /\/v2\/$/.test(p)) return 'no-cache';
	return 'public, max-age=1500';
}

/**
 * 代理请求
 * @param {URL} urlObj URL对象
 * @param {RequestInit} reqInit 请求初始化对象
 */
async function proxy(urlObj, reqInit) {
	const res = await fetch(urlObj.href, reqInit);
	const headers = buildUpstreamHeaders(urlObj, res, null);
	return new Response(res.body, {
		status: res.status,
		headers: headers
	});
}

async function ADD(envadd) {
	var addtext = envadd.replace(/[	 |"'\r\n]+/g, ',').replace(/,+/g, ',');	// 将空格、双引号、单引号和换行符替换为逗号
	if (addtext.charAt(0) == ',') addtext = addtext.slice(1);
	if (addtext.charAt(addtext.length - 1) == ',') addtext = addtext.slice(0, addtext.length - 1);
	const add = addtext.split(',');
	return add;
}