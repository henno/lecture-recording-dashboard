import {expect,test} from 'bun:test';
import {resolveLectureFolder,findExistingVideo} from './lecture-folders';
const folder={id:'target',name:'TAK25',mimeType:'application/vnd.google-apps.folder',trashed:false,
 permissions:[{id:'class',type:'group',role:'reader'}]};
const config={rootFolderId:'root',groupFolders:{TAK25:'target'},groupPermissions:{TAK25:['class']}};
function drive(entries:any[]=[folder],metadata:any=folder):any{return {files:{
 list:async()=>({data:{files:entries}}),get:async()=>({data:metadata})}};}
test('resolve exact group folder with verified class access',async()=>{
 expect(await resolveLectureFolder(drive(),config,'TAK25')).toBe('target');
});
test('missing and duplicate folders stop without root fallback',async()=>{
 for(const entries of [[],[folder,folder]])await expect(resolveLectureFolder(drive(entries),config,'TAK25')).rejects.toThrow();
 await expect(resolveLectureFolder(drive(),config,'TAK26')).rejects.toThrow();
});
test('public folder and missing class permission are rejected',async()=>{
 for(const permissions of [[],[...folder.permissions,{id:'public',type:'anyone',role:'reader'}]])
  await expect(resolveLectureFolder(drive([folder],{...folder,permissions}),config,'TAK25')).rejects.toThrow();
});
test('matching video reuses ID and changed or duplicate video is preserved',async()=>{
 const file={id:'existing',name:'TAK25 - 2026-11-16.mp4',mimeType:'video/mp4',size:'3',md5Checksum:'hash'};
 expect(await findExistingVideo(drive([file]),'target',file.name,3,'hash')).toBe('existing');
 await expect(findExistingVideo(drive([file]),'target',file.name,3,'other')).rejects.toThrow();
 await expect(findExistingVideo(drive([file,file]),'target',file.name,3,'hash')).rejects.toThrow();
});

test('read local media hash and verify final class access before completion',async()=>{
 const {localVideoMd5,verifyLectureVideo}=await import('./lecture-folders');
 const path=import.meta.dir+'/../.test-video-hash';
 await Bun.write(path,'abc');
 try {expect(await localVideoMd5(path)).toBe('900150983cd24fb0d6963f7d28e17f72');}
 finally {await Bun.file(path).delete();}
 const video={id:'video',mimeType:'video/mp4',trashed:false,parents:['target'],size:'3',md5Checksum:'hash',permissions:folder.permissions};
 const api:any={files:{get:async({fileId}:any)=>({data:fileId==='target'?folder:video})}};
 await verifyLectureVideo(api,config,'TAK25','video','target',3,'hash');
 video.permissions=[];
 await expect(verifyLectureVideo(api,config,'TAK25','video','target',3,'hash')).rejects.toThrow();
});
