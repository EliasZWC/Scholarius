"""
本地静态服务器，**强制禁用缓存**。

存在的理由：Python 自带的 `http.server` 会发 Last-Modified/ETag，
浏览器（尤其 Playwright 复用 profile 时）会给子资源返回 304，
于是**改了 JS 但页面还在跑旧代码** —— 排查时会误以为"改动没生效"，
白折腾好几轮。这里直接发 no-store，杜绝该问题。

用法（在 assets/www 目录下）：
    python ../../../../../tools/serve_nocache.py 8899
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def send_head(self):
        # 去掉条件请求头，避免 304
        for h in ('If-Modified-Since', 'If-None-Match'):
            if h in self.headers:
                del self.headers[h]
        return super().send_head()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    root = sys.argv[2] if len(sys.argv) > 2 else None
    if root:
        import os
        os.chdir(root)
        print('serving: ' + os.getcwd())
    ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler).serve_forever()
