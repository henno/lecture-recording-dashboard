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
