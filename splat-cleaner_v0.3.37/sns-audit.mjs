/** Opt-in, same-geometry audit. Never change normal search budgets. */
import {assert,tick} from './core.mjs';
import {analyzeSnsBidirectionalSupport,compareSnsResults} from './sns-support.mjs';
import {analyzeSnsBidirectionalSupport as historical} from './reference/sns-support-v0310.mjs';
export const LEGACY_BUDGETS=Object.freeze({maxCellsPerQuery:8192,maxComparisonsPerQuery:50000,maxReverseNodesPerQuery:8192,maxReverseComparisonsPerQuery:50000});
export const CURRENT_BUDGETS=Object.freeze({maxCellsPerQuery:16384,maxComparisonsPerQuery:100000,maxReverseNodesPerQuery:16384,maxReverseComparisonsPerQuery:100000});
const summary=r=>({outgoing_candidates:r.outgoingCandidateCount,reverse_supported:r.reverseSupportedCount,reverse_inconclusive:r.reverseInconclusiveCount,final_candidates:r.candidateCount,inconclusive:r.inconclusiveCount,supported:r.supportedCount,locked_excluded:r.lockedExcluded,invalid:r.invalidCount,cell_width:r.cellWidth});
export async function candidateTransitions(before,after,{cancelled=()=>false}={}){
    const n=before.candidateMask.length;assert(after.candidateMask.length===n,'SNS audit length mismatch.');
    const out={unchanged_candidates:0,added_from_inconclusive:0,added_from_other_retained:0,removed_to_inconclusive:0,removed_to_other_retained:0,first_added:[],first_removed:[]};let last=performance.now();
    for(let i=0;i<n;i++){
        if(i%65536===0){assert(!cancelled(),'SNS analysis cancelled.');if(performance.now()-last>=16){await tick();last=performance.now();}}
        if(before.candidateMask[i]&&after.candidateMask[i])out.unchanged_candidates++;
        else if(after.candidateMask[i]){out[before.inconclusiveMask[i]?'added_from_inconclusive':'added_from_other_retained']++;if(out.first_added.length<10)out.first_added.push(i);}
        else if(before.candidateMask[i]){out[after.inconclusiveMask[i]?'removed_to_inconclusive':'removed_to_other_retained']++;if(out.first_removed.length<10)out.first_removed.push(i);}
    }
    assert(!cancelled(),'SNS analysis cancelled.');return out;
}
export async function auditSnsCompatibility(hybrid,centers,geometry,{k=3,minSupport=1,includeHistory=false,cancelled=()=>false,progress=()=>{}}={}){
    const t=performance.now();
    // Disable new sparse traversal as well as both GPU backends for the v0.3.16 CPU baseline.
    const cpu=await analyzeSnsBidirectionalSupport(centers,geometry,{k,minSupport,...CURRENT_BUDGETS,sparseCpu:false,cancelled,progress:(d,n,s)=>progress(d,n,'current CPU '+s)});
    const verification={...await compareSnsResults(hybrid,cpu,{cancelled}),cpu_reference_ms:Math.round(performance.now()-t),result_used:'hybrid'};
    verification.current_cpu=summary(cpu);verification.hybrid=summary(hybrid);
    verification.hybrid_vs_current_cpu=await candidateTransitions(cpu,hybrid,{cancelled});
    if(includeHistory){
        if(k<1||k>5||!Number.isInteger(k*2)||minSupport<1||minSupport>10||!Number.isInteger(minSupport))verification.historical={status:'not_applicable',reason:'v0.3.10 supports k=1–5 (step 0.5), m=1–10 only; no clamping performed.'};
        else{
            const start=performance.now();
            const old=await historical(centers,geometry,{k,minSupport,...LEGACY_BUDGETS,cancelled,progress:(d,n,s)=>progress(d,n,'v0.3.10 CPU '+s)});
            verification.historical={status:'compared',legacy_budgets:LEGACY_BUDGETS,current_budgets:CURRENT_BUDGETS,reference:summary(old),cpu_ms:Math.round(performance.now()-start),
                current_vs_legacy:await candidateTransitions(old,cpu,{cancelled}),comparison:await compareSnsResults(cpu,old,{cancelled})};
        }
    }
    let result=hybrid;
    if(!verification.match){
        verification.result_used='cpu_reference';verification.hybrid_timings_ms=hybrid.timings;verification.hybrid_outgoing_acceleration=hybrid.outgoingAcceleration;verification.hybrid_reverse_acceleration=hybrid.reverseAcceleration;
        result=cpu;result.outgoingAcceleration={backend:'cpu',reason:'CPU reference selected after verification mismatch'};
    }
    return {result,verification};
}
