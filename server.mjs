// Optional dependency-free Node.js static server. Serves this directory only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT||8765),host=process.argv.includes('--lan')?'0.0.0.0':'127.0.0.1';
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.glb':'model/gltf-binary','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.md':'text/plain; charset=utf-8'};
http.createServer((req,res)=>{
 try{
  let pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(pathname.endsWith('/'))pathname+='index.html';
  const filename=path.resolve(root,'.'+pathname),relative=path.relative(root,filename);
  if(relative.startsWith('..')||path.isAbsolute(relative)){res.writeHead(403);res.end();return;}
  fs.stat(filename,(err,stat)=>{if(err||!stat.isFile()){res.writeHead(404);res.end('Not found');return;}
   res.writeHead(200,{'Content-Type':types[path.extname(filename)]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-cache'});
   if(req.method==='HEAD'){res.end();return;}const stream=fs.createReadStream(filename);stream.on('error',()=>res.destroy());stream.pipe(res);
  });
 }catch{res.writeHead(400);res.end('Bad request');}
}).listen(port,host,()=>console.log(`OSCAR viewer: http://127.0.0.1:${port}/web/`));
