import type {drive_v3} from 'googleapis';
export interface LectureDestination {
  rootFolderId: string;
  groupFolders: Record<string,string>;
  groupPermissions: Record<string,string[]>;
}
async function list(drive:drive_v3.Drive,q:string):Promise<drive_v3.Schema$File[]> {
  const files:drive_v3.Schema$File[]=[];
  let pageToken:string|undefined;
  do {
    const result=await drive.files.list({q,fields:'nextPageToken,files(id,name,mimeType,shortcutDetails,size,md5Checksum)',pageSize:1000,pageToken});
    files.push(...result.data.files||[]);pageToken=result.data.nextPageToken||undefined;
  } while(pageToken);
  return files;
}
export async function resolveLectureFolder(drive:drive_v3.Drive,config:LectureDestination,group:string):Promise<string> {
  const id=config?.groupFolders?.[group],expected=config?.groupPermissions?.[group];
  if(!/^[A-Za-z0-9_-]+$/.test(group)||!id||!config.rootFolderId||!expected?.length)
    throw Error('No verified lecture folder and class permission for this group');
  const entries=await list(drive,`'${config.rootFolderId}' in parents and name='${group}' and trashed=false`);
  if(entries.length!==1)throw Error('The lecture group folder is missing or ambiguous');
  const entry=entries[0]!;
  if((entry.mimeType==='application/vnd.google-apps.shortcut'?entry.shortcutDetails?.targetId:entry.id)!==id)
    throw Error('The lecture group folder changed');
  const {data:folder}=await drive.files.get({fileId:id,fields:'id,mimeType,trashed,permissions(id,type,role,view)'});
  const permissions=folder.permissions||[];
  if(folder.mimeType!=='application/vnd.google-apps.folder'||folder.trashed!==false||
      expected.some(id=>!permissions.some(p=>p.id===id&&p.type==='group'&&p.view!=='metadata'&&['reader','commenter','writer','owner'].includes(p.role||'')))||
      permissions.some(p=>p.type==='anyone'&&p.view!=='metadata'))
    throw Error('The lecture group folder needs verified restricted class access');
  return id;
}
export async function findExistingVideo(drive:drive_v3.Drive,folder:string,name:string,size:number,md5:string):Promise<string|undefined> {
  const escaped=name.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  const files=await list(drive,`'${folder}' in parents and name='${escaped}' and trashed=false`);
  if(!files.length)return undefined;
  if(files.length!==1||files[0]!.mimeType!=='video/mp4'||Number(files[0]!.size)!==size||files[0]!.md5Checksum!==md5)
    throw Error('An existing lecture video conflicts; it was preserved');
  return files[0]!.id||undefined;
}
