"""Serve only the deliverable folder. No external dependencies. Default: local only.
Use --lan explicitly for trusted local-network phone/tablet preview.
"""
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
import argparse,functools,webbrowser
p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8765);p.add_argument('--lan',action='store_true');p.add_argument('--no-open',action='store_true');a=p.parse_args()
root=Path(__file__).resolve().parent
host='0.0.0.0' if a.lan else '127.0.0.1'
class Handler(SimpleHTTPRequestHandler):
    extensions_map={**SimpleHTTPRequestHandler.extensions_map,'.js':'text/javascript','.glb':'model/gltf-binary','.md':'text/plain; charset=utf-8'}
    def end_headers(self):self.send_header('Cache-Control','no-cache');super().end_headers()
url=f'http://127.0.0.1:{a.port}/web/'
server=ThreadingHTTPServer((host,a.port),functools.partial(Handler,directory=str(root)))
print(f'OSCAR viewer: {url}',flush=True)
if a.lan:print('LAN mode: use this computer LAN IPv4 and the same port on a trusted network.',flush=True)
if not a.no_open:webbrowser.open(url)
try:server.serve_forever()
except KeyboardInterrupt:server.server_close()
