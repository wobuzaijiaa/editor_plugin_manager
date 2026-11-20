// Windows-only launcher. The hidden waiter owns the visible shell;
// the shell invokes the exact resolved Node + CLI, not an npm shim or PATH lookup.
import path from 'node:path';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';

const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
const encoded=s=>Buffer.from(s,'utf16le').toString('base64');
const flags=['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand'];
export function buildPowerShellLaunch({shell,node,cli,args,cwd}){
    const log=path.join(cwd,'powershell-cli.log'),status=path.join(cwd,'powershell-cli.exit');
    // Windows PowerShell 5.1 writes native stderr as ErrorRecords when merged.
    // Continue is deliberate: the CLI itself reports progress on stderr.
    // The separate completion marker prevents a closed window from looking successful.
    const command=`$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath ${quote(cwd)}
$Host.UI.RawUI.WindowTitle = 'Splat Cleaner - GPU Floaters'
$node = ${quote(node)}
$cliArgs = @(${[cli,...args].map(quote).join(',')})
$writer = [System.IO.StreamWriter]::new(${quote(log)}, $false, [System.Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
try {
    Write-Host 'Splat Cleaner: running SplatTransform. The Editor will receive the result when this window closes.'
    $global:LASTEXITCODE = $null
    $ErrorActionPreference = 'Continue'
    & $node @cliArgs 2>&1 | ForEach-Object {
        $line = $_.ToString()
        try { $writer.WriteLine($line) } catch { throw }
        Write-Host $line
    }
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($null -eq $code) { throw 'CLI did not provide an exit code.' }
    $writer.Flush()
    [System.IO.File]::WriteAllText(${quote(status)}, [string]$code)
    exit $code
} finally { $writer.Dispose() }
`;
    const inner=[...flags,encoded(command)];
    const waiter=`$ErrorActionPreference = 'Stop'
$p = Start-Process -FilePath ${quote(shell)} -ArgumentList @(${inner.map(quote).join(',')}) -WorkingDirectory ${quote(cwd)} -WindowStyle Normal -PassThru -Wait
exit $p.ExitCode
`;
    return {shell,args:[...flags,encoded(waiter)],log,status,command,waiter};
}
// Wait for normal exit; cancel only this owned Windows process tree. Never
// abandon the waiter while its CLI can still be writing the job directory.
export async function invokePowerShellCli(cli,args,{cwd,signal,record,spawnImpl=spawn,systemRoot=process.env.SystemRoot||'C:\\Windows',node=process.execPath}={}){
    signal?.throwIfAborted();
    const shell=path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
    const taskkill=path.join(systemRoot,'System32','taskkill.exe');
    const launch=buildPowerShellLaunch({shell,node,cli,args,cwd});
    // Only fresh, processor-owned job paths are accepted.
    for(const file of [launch.log,launch.status]){
        try{await fs.lstat(file);throw Error(`Unexpected pre-existing PowerShell job file: ${file}`);}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    signal?.throwIfAborted();
    const child=spawnImpl(shell,launch.args,{cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let output='',gpuError=false,problem,killPromise,closed=false;const tails=['',''];
    const collect=(chunk,i)=>{const s=chunk.toString();output=(output+s).slice(-65536);gpuError ||= /WebGPU\s+(?:device lost|out-of-memory|error):/i.test((tails[i]+s).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,''));tails[i]=s.slice(-256);try{record?.write(chunk,i);}catch(e){problem??=e;abort();}const stream=i?process.stderr:process.stdout;if(!stream.destroyed)stream.write(chunk);};
    const abort=()=>{
        if(closed||killPromise||!child.pid)return;
        killPromise=new Promise(resolve=>{
            try{
                const k=spawnImpl(taskkill,['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
                k.once('error',e=>{problem??=e;resolve();});
                k.once('close',code=>{if(code!==0&&!closed)problem??=Error(`Owned PowerShell tree cancellation failed (taskkill ${code})`);resolve();});
            }catch(e){problem??=e;resolve();}
        });
    };
    const result=await new Promise(resolve=>{
        child.stdout.on('data',c=>collect(c,0));child.stderr.on('data',c=>collect(c,1));
        child.on('error',e=>{problem??=e;});
        child.once('close',(code,sig)=>{closed=true;signal?.removeEventListener('abort',abort);resolve({code,signal:sig});});
        signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
    await killPromise;
    // The visible shell writes merged CLI text locally. Import it only after
    // the waiter exits, so no live CLI output pipe leads through the Manager.
    let cliCode=null;
    try{
        const log=await fs.readFile(launch.log);if(!log.length)throw Error('PowerShell CLI log is empty.');collect(log,1);
        const marker=(await fs.readFile(launch.status,'utf8')).trim();if(!/^-?\d+$/.test(marker))throw Error('Invalid PowerShell CLI completion marker.');cliCode=Number(marker);
        if(cliCode!==result.code)throw Error(`PowerShell waiter/CLI exit mismatch (${result.code}/${cliCode})`);
    }catch(e){problem??=e;}
    if(record)record.result={code:cliCode??result.code,signal:result.signal,gpuError,launchMode:'powershell-window',waiterCode:result.code,launchError:problem?.message};
    if(signal?.aborted)throw Error(`Native Floaters cancelled.${problem?' '+problem.message:''}`);
    if(gpuError||result.code!==0||cliCode!==0||problem)throw Error(`Original SplatTransform CLI failed (exit ${cliCode??result.code}, signal ${result.signal}, GPU error ${gpuError}): ${problem?problem.message+'; ':''}${output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').trim().slice(-1800)}`);
    return output;
}
