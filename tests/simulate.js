// Fake vscode + fake Overleaf to exercise bisync without touching the real server.
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),Module=require('module');
const EXT=path.join(__dirname,'..','extension');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bisync-test-'));
let nid=1;const id=()=>'id'+nid++;
class Uri{constructor(s,a,p,q){this.scheme=s;this.authority=a;this.path=p;this.query=q||''}
 static parse(x){const m=/^([^:]+):\/\/([^/]*)([^?]*)\??(.*)$/.exec(x);return new Uri(m[1],m[2],m[3],m[4])}
 static joinPath(u,...p){return new Uri(u.scheme,u.authority,path.posix.join(u.path,...p),u.query)}
 toString(){return this.scheme+'://'+this.authority+this.path}}
const FT={File:1,Directory:2,SymbolicLink:64};
const nf=()=>Object.assign(Error('FileNotFound'),{code:'FileNotFound'});
const L=u=>tmp+u.path.replace(/^\/w/,'');
const rootFolder={_id:'r',name:'',docs:[],fileRefs:[],folders:[]};
const server={};const blobs={};let downloads=0,joins=0,lie=false;
const rp=u=>u.path.split('/').slice(2);
const find=u=>{const ps=rp(u);let f=rootFolder;for(const x of ps.slice(0,-1)){f=f.folders.find(y=>y.name===x);if(!f)throw nf()}const n=ps.at(-1);const doc=f.docs.find(d=>d.name===n),file=f.fileRefs.find(d=>d.name===n),fo=f.folders.find(d=>d.name===n);return{parentFolder:f,fileName:n,fileEntity:doc||file||fo,fileType:doc?'doc':file?'file':fo?'folder':undefined}};
function rset(name,content){const ps=name.split('/');let f=rootFolder;for(const x of ps.slice(0,-1)){let g=f.folders.find(y=>y.name===x);if(!g){g={_id:id(),name:x,docs:[],fileRefs:[],folders:[]};f.folders.push(g)}f=g}
 const n=ps.at(-1);if(/\.(tex|bib)$/.test(n)||n==='latexmkrc'){let d=f.docs.find(x=>x.name===n);if(!d){d={_id:id(),name:n};f.docs.push(d)}server[d._id]=content}
 else{f.fileRefs=f.fileRefs.filter(x=>x.name!==n);const e={_id:id(),name:n,hash:crypto.createHash('sha1').update(`blob ${Buffer.from(content).length}\0`).update(content).digest('hex')};if(global.noHash)delete e.hash;f.fileRefs.push(e);blobs[e._id]=Buffer.from(content)}}
const rget=name=>{const{fileEntity:e,fileType:t}=find({path:'/P/'+name});return t==='doc'?server[e._id]:t?blobs[e._id].toString():null};
const rdel=name=>{const{parentFolder:f,fileName:n}=find({path:'/P/'+name});f.docs=f.docs.filter(x=>x.name!==n);f.fileRefs=f.fileRefs.filter(x=>x.name!==n)};
const vfs={root:{rootFolder:[rootFolder]},init:async()=>{},_resolveUri:async u=>find(u),scmCollectionItem:{collection:{scms:[],updateStatus(){}}},getProjectSCMPersist(){return undefined},
 socket:{handlers:[],updateEventHandlers(h){this.handlers.push(h)},async joinDoc(i){joins++;if(!(i in server))throw Error('no doc');return{docLines:server[i].split('\n'),version:1}}},
 api:{url:'https://h/',uploadFile:async()=>{throw Error('orig')}},
 async writeFile(u,c){if(lie)return;const{fileEntity:e}=find(u);const t=new TextDecoder().decode(c);if(e.remoteCache!==server[e._id])throw Error('stale cache');server[e._id]=t;e.remoteCache=t},
 async createFile(u,c){const{parentFolder:f,fileName:n}=find(u);const r=await this.api.uploadFile({},'p',f._id,n,c);(r.entity._type==='doc'?f.docs:f.fileRefs).push(r.entity)}};
const answers=[];const asked=[];
const readR=async u=>{downloads++;const{fileEntity:e,fileType:t}=find(u);if(!e)throw nf();return t==='doc'?Buffer.from(server[e._id]):blobs[e._id]};
const vscode={Uri,FileType:FT,ProgressLocation:{Notification:1},
 workspace:{textDocuments:[],workspaceFolders:[],fs:{
  async readFile(u){if(u.scheme!=='file')return readR(u);try{return fs.readFileSync(L(u))}catch{throw nf()}},
  async writeFile(u,d){fs.mkdirSync(path.dirname(L(u)),{recursive:true});fs.writeFileSync(L(u),d)},
  async readDirectory(u){try{return fs.readdirSync(L(u),{withFileTypes:true}).map(e=>[e.name,e.isDirectory()?2:1])}catch{throw nf()}},
  async stat(u){if(u.scheme!=='file'){const r=find(u);if(!r.fileType)throw nf();return{type:r.fileType==='folder'?2:1}}try{const s=fs.statSync(L(u));return{mtime:s.mtimeMs,size:s.size}}catch{throw nf()}},
  async createDirectory(u){const{parentFolder:f,fileName:n}=find(u);f.folders.push({_id:id(),name:n,docs:[],fileRefs:[],folders:[]})},
  async delete(u,o){if(u.scheme!=='file'){rdel(rp(u).join('/'));return}try{fs.statSync(L(u))}catch{throw nf()}fs.rmSync(L(u),{recursive:true})}}},
 window:{async showWarningMessage(m,o,...b){if(o&&o.modal){asked.push(m);const a=answers.shift();if(a!==undefined&&!b.includes(a))throw Error('bad answer '+a+' for '+b);return a}},async showInformationMessage(){},async showErrorMessage(m){asked.push('ERR '+m)},setStatusBarMessage(){},async withProgress(o,f){return f({report(){}})},async showTextDocument(){}},
 extensions:{getExtension(){return{activate:async()=>{}}}},commands:{async executeCommand(){return vfs}}};
const orig=Module._load;Module._load=function(r,p,...x){if(r==='vscode')return vscode;if(r==='./multipart')return{sendFile:async o=>{const t=/\.(tex|bib)$/.test(o.filename)||o.filename==='latexmkrc'?'doc':'file';const i=id();if(t==='doc')server[i]=o.bytes.toString();else blobs[i]=Buffer.from(o.bytes);const e={_type:t,_id:i,name:o.filename};return{type:'success',entity:e}}};return orig.call(this,r,p,...x)};
const b=require(EXT+'/bisync.js');const root=new Uri('file','','/w');
const out={appendLine(l){if(/Error|错误/.test(l))console.log('   out:',l.split('\n')[0])},clear(){},show(){}};
const W=(n,t)=>{const f=path.join(tmp,n);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,t)};const R=n=>{try{return fs.readFileSync(path.join(tmp,n),'utf8')}catch{return null}};
let fail=0;const ok=(c,m)=>{console.log((c?'ok   ':'FAIL ')+m);if(!c)fail++};
const sync=async(...a)=>{answers.length=0;answers.push(...a);asked.length=0;downloads=0;joins=0;return b.runManual(root,false,out)};
const auto=async()=>{asked.length=0;const s=new b.Session(root,out);await s.open();return s.run('auto')};
(async()=>{
 W('.overleaf/settings.json',JSON.stringify({uri:'overleaf-workshop://h/P?user=&project=p',serverName:'h',projectName:'P'}));W('.overleaf/bisync.json',JSON.stringify({textDirs:['','chapters','misc','reference']}));
 const L10=Array.from({length:10},(_,i)=>'第'+(i+1)+'行\n').join('');
 W('main.tex','\\input{chapters/a}\r\n% \\includegraphics{figures/x/commented.png}\r\n');W('chapters/a.tex',L10+'\\includegraphics[width=1cm]{./figures/x/used.png} 50\\% \\includegraphics{figures/x/noext}\n');
 W('figures/x/used.png','PNG1');W('figures/x/noext.pdf','PDF1');W('figures/x/unused.png','U');W('figures/x/commented.png','C');W('figures/big.pptx','P');W('.vscode/settings.json','{}');W('figures/src/z.tex','z');
 rset('main.tex',R('main.tex').replace(/\r/g,''));rset('chapters/a.tex',R('chapters/a.tex'));rset('figures/x/used.png','PNG1');rset('chapters/old.tex','old');rset('.git/hooks/x.tex','evil');
 let r=await auto();ok(!r.counts.pull&&R('chapters/old.tex')===null,'auto does nothing before the first manual run');
 r=await b.runManual(root,true,out);ok(r.counts.same===3&&r.counts['push-new']===1&&r.counts['pull-new']===1&&!R('.overleaf/bisync-state.json'),'check is read-only '+JSON.stringify(r.counts));
 r=await sync('忽略这些文件');ok(r.counts.same===3&&r.counts.push===1&&r.counts.ignored===1&&rget('figures/x/noext.pdf')==='PDF1','first run '+JSON.stringify(r.counts));
 ok(find({path:'/P/figures/x/unused.png'}).fileEntity===undefined&&find({path:'/P/figures/x/commented.png'}).fileEntity===undefined,'unreferenced images not uploaded');ok(R('.git/hooks/x.tex')===null,'hidden remote path not written');
 ok(R('main.tex').includes('\r\n'),'CRLF local equals LF remote, left alone');
 r=await sync();ok(r.counts.same===4&&Object.keys(r.counts).length===1&&downloads===0&&asked.length===0,'second run: nothing downloaded, joins='+joins);
 // different lines merge
 W('chapters/a.tex',R('chapters/a.tex').replace('第2行','第2行本地'));rset('chapters/a.tex',rget('chapters/a.tex').replace('第9行','第9行远端'));
 r=await sync();ok(asked.length===0&&/第2行本地/.test(rget('chapters/a.tex'))&&/第9行远端/.test(R('chapters/a.tex'))&&rget('chapters/a.tex')===R('chapters/a.tex'),'line merge both kept '+JSON.stringify(r.counts));
 // auto merge then pending push
 W('chapters/a.tex',R('chapters/a.tex').replace('第1行','第1行L'));rset('chapters/a.tex',rget('chapters/a.tex').replace('第6行','第6行R'));
 r=await auto();ok(r.counts.merged===1&&/第6行R/.test(R('chapters/a.tex'))&&!/第1行L/.test(rget('chapters/a.tex')),'auto merges locally and does not upload');
 r=await sync();ok(r.counts.push===1&&/第1行L/.test(rget('chapters/a.tex')),'then manual sync uploads');
 // same line conflict
 W('chapters/a.tex',R('chapters/a.tex').replace('第4行','第4行L'));rset('chapters/a.tex',rget('chapters/a.tex').replace('第4行','第4行R').replace('第10行','第10行R'));
 const before=R('chapters/a.tex');r=await auto();ok(r.counts.conflict===1&&R('chapters/a.tex')===before&&asked.length===0,'auto leaves conflict untouched, no modal');
 r=await sync('采用本地');ok(asked.length===1&&/第4行L/.test(rget('chapters/a.tex'))&&/第10行R/.test(rget('chapters/a.tex')),'conflict asks once, rest merged');
 W('chapters/a.tex',R('chapters/a.tex').replace('第5行','第5行L'));rset('chapters/a.tex',rget('chapters/a.tex').replace('第5行','第5行R'));
 r=await sync('手动编辑');ok(/<<<<<<< 本地/.test(R('chapters/a.tex'))&&!/<<</.test(rget('chapters/a.tex')),'manual edit leaves markers locally');
 r=await sync();ok(r.counts.error===1&&!/<<</.test(rget('chapters/a.tex')),'markers block upload');
 W('chapters/a.tex',R('chapters/a.tex').replace(/<<<<<<< 本地\n(.*\n)=======\n.*\n>>>>>>> 远端\n/,'$1'));r=await sync();ok(r.counts.push===1,'resolved uploads');
 // CRLF pull keeps EOL
 rset('main.tex',rget('main.tex')+'新行\n');r=await sync();ok(R('main.tex').endsWith('新行\r\n')&&rget('main.tex').indexOf('\r')<0,'pull keeps CRLF');
 ok(fs.readdirSync(path.join(tmp,'.overleaf/bisync-backup')).length>0,'backups exist');
 // images
 rset('figures/x/used.png','PNG2');r=await sync();ok(R('figures/x/used.png')==='PNG2'&&downloads===1,'remote image replaced -> one download');
 W('figures/x/new图.png','N');W('chapters/a.tex',R('chapters/a.tex')+'\\includegraphics{figures/x/new图.png}\n');r=await sync();ok(rget('figures/x/new图.png')==='N','newly referenced image uploads by itself');
 rset('chapters/colleague.tex','hi');r=await auto();ok(R('chapters/colleague.tex')==='hi','auto pulls new remote file');
 // latexmkrc
 W('latexmkrc','a');rset('latexmkrc','a');await sync();rset('latexmkrc','evil');r=await auto();ok(R('latexmkrc')==='a'&&r.counts.conflict===1,'latexmkrc never auto-pulled');r=await sync('用本地覆盖远端');ok(rget('latexmkrc')==='a','latexmkrc choice '+JSON.stringify(r.counts));
 // deletes
 rdel('chapters/colleague.tex');r=await auto();ok(R('chapters/colleague.tex')==='hi'&&r.counts['delete-pending']===1,'auto never deletes');r=await sync('重新上传');ok(rget('chapters/colleague.tex')==='hi','re-upload after remote delete');
 fs.rmSync(path.join(tmp,'chapters/colleague.tex'));r=await sync(undefined);ok(rget('chapters/colleague.tex')==='hi','cancel keeps remote');r=await sync('同时删除远端');ok(find({path:'/P/chapters/colleague.tex'}).fileEntity===undefined,'delete remote after confirm');
 // dirty editor
 rset('main.tex',rget('main.tex')+'x\n');vscode.workspace.textDocuments=[{isDirty:true,uri:Uri.joinPath(root,'main.tex')}];const m=R('main.tex');r=await auto();ok(R('main.tex')===m&&r.counts.dirty===1,'dirty editor untouched');vscode.workspace.textDocuments=[];await sync();
 // server silently drops write
 W('chapters/a.tex',R('chapters/a.tex')+'z\n');lie=true;r=await sync();ok(r.counts.error===1,'dropped write is detected');lie=false;r=await sync();ok(r.counts.push===1&&/z\n$/.test(rget('chapters/a.tex')),'retry works');
 r=await sync();ok(Object.keys(r.counts).join()==='same','steady state');
 console.log(fail?'FAILED '+fail:'ALL PASSED');fs.rmSync(tmp,{recursive:true});
})().catch(e=>{console.error(e);process.exit(1)});
