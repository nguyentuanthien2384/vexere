'use strict';

const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');

function closeServer(server){
  if(!server)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    server.close(error=>{if(error&&error.code!=='ERR_SERVER_NOT_RUNNING')reject(error);else resolve();});
    // Stop accepting requests before destroying active/idle fixture connections.
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
  });
}

async function cleanupBrowserTest({browser,server,runtime,dataDir,prefix},testFailure){
  const failures=[];
  const results=await Promise.allSettled([
    Promise.resolve().then(()=>browser?.close()),
    closeServer(server),
  ]);
  results.forEach((result,index)=>{if(result.status==='rejected')failures.push(new Error((index===0?'Browser':'HTTP server')+' cleanup failed',{cause:result.reason}));});
  // A failed browser/server close must not prevent closing the fixture database.
  try{await runtime?.close();}catch(error){failures.push(new Error('Fixture database cleanup failed',{cause:error}));}
  try{
    const target=path.resolve(dataDir),temporaryRoot=path.resolve(os.tmpdir())+path.sep;
    if(!prefix||!target.startsWith(temporaryRoot)||!path.basename(target).startsWith(prefix))throw new Error('Invalid temporary cleanup path.');
    await fs.rm(target,{recursive:true,force:true});
  }catch(error){failures.push(new Error('Temporary fixture cleanup failed',{cause:error}));}
  if(failures.length)throw new AggregateError(testFailure?[testFailure,...failures]:failures,'Browser test cleanup failed');
}

module.exports={cleanupBrowserTest};
