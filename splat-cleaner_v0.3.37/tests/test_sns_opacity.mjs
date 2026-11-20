import test from 'node:test';
import assert from 'node:assert/strict';
import {computeSelection, candidateMaskForRule, RULE_BITS, buildReport, subsetRuns} from '../core.mjs';
import {__testing} from '../index.js';
const centers={x:Float64Array.of(0,1,2,3,4,5),y:new Float64Array(6),z:new Float64Array(6)};
const density={classes:Uint8Array.of(0,0,0,0,1,1)};
const config={roi:{x:{min:0,max:5},y:{min:0,max:0},z:{min:0,max:0}},density:'all',snsEnabled:true,snsK:3,snsMinNeighbors:1,opacityMode:'restrict-sns',opacityThreshold:.25,opacityEncoding:'linear'};
const attrs={snsMask:Uint8Array.of(1,1,1,0,1,0),opacity:Float32Array.of(.125,.25,.5,.125,0,1),splatTransformMask:Uint8Array.of(0,1,0,0,1,1)};
const select=(c={},a=attrs)=>computeSelection(centers,density,{...config,...c},a);
test('SNS-O-01 optional AND filter, strict cutoff, raw mask unchanged',()=>{
    assert.deepEqual([...select().candidates],[1,0,0,0,1,0]);
    assert.deepEqual([...select({opacityThreshold:0}).candidates],[0,0,0,0,0,0]);
    assert.deepEqual([...select({opacityThreshold:1}).candidates],[1,1,1,0,1,0]);
    assert.deepEqual([...select({opacityMode:'off'},{snsMask:attrs.snsMask}).candidates],[1,1,1,0,1,0]);
    assert.deepEqual([...attrs.snsMask],[1,1,1,0,1,0]);
});
test('SNS-O-02 mutually exclusive modes, OR attribution, overlap, tint and retained runs',()=>{
    const s=select({splatTransformEnabled:true});
    assert.deepEqual([...s.ruleBits],[4,16,0,0,20,16]);
    assert.equal(s.ruleCounts.sns,2);assert.equal(s.ruleCounts.opacity,0);assert.equal(s.snsGpuOverlap,1);
    assert.equal(s.candidateCount,4);assert.deepEqual(subsetRuns(s.candidates).runs,[[2,2]]);
    assert.deepEqual([...candidateMaskForRule(s,RULE_BITS.sns)],[1,0,0,0,1,0]);
    assert.deepEqual([...__testing.inspectionCandidateMask(s,'sns',centers,density,{...config,splatTransformEnabled:true},attrs)],[1,0,0,0,1,0]);
    const independent=select({opacityMode:'independent',splatTransformEnabled:true});
    assert.deepEqual([...independent.ruleBits],[6,20,4,2,22,16]);
    assert.equal(independent.ruleCounts.opacity,3);assert.equal(independent.ruleCounts.sns,4);
    assert.equal(independent.snsGpuOverlap,2);
    assert.equal(__testing.methodSelectedForTint('opacity',config),false);
    assert.equal(__testing.methodSelectedForTint('opacity',{...config,opacityMode:'independent'}),true);
});
test('SNS-O-03 XYZ and density scope restrict effective SNS only',()=>{
    const s=select({density:'sparse',roi:{...config.roi,x:{min:0,max:3}}});
    assert.deepEqual([...s.candidates],[1,0,0,0,0,0]);assert.equal(s.ruleCounts.sns,1);
});
test('SNS-O-04 active filter fails closed for invalid cutoffs or unavailable opacity',()=>{
    for(const v of [NaN,Infinity,-.1,1.1,'0.1',null,undefined])assert.throws(()=>select({opacityThreshold:v}),/Opacity threshold/);
    for(const v of [null,new Float32Array(5)])assert.throws(()=>select({}, {...attrs,opacity:v}),/Opacity data unavailable/);
    assert.deepEqual([...select({snsEnabled:false,opacityThreshold:NaN},{opacity:null}).candidates],Array(6).fill(0));
});
test('SNS-O-05 report preserves schema and records effective filter and raw diagnostics separately',()=>{
    const report=buildReport({density,config,selection:select(),total:6,attributeStatus:{},sns:{candidateCount:4}});
    assert.equal(report.version,2);assert.equal(report.tool_version,'0.3.37');
    assert.deepEqual(report.selection.scale_normalized_support.opacity_filter,{enabled:true,type:'below',cutoff:.25,source_interpretation:'linear'});
    assert.equal(report.selection.opacity.mode,'restrict-sns');assert.equal(report.selection.opacity.shared_threshold,.25);
    assert.equal(report.selection.opacity.enabled,false);assert.equal(report.analysis.scale_normalized_support.candidateCount,4);assert.equal(report.candidate_by_rule.sns,2);
    const off={...config,opacityMode:'off'};
    assert.equal(buildReport({density,config:off,selection:select(off),total:6,attributeStatus:{}}).selection.scale_normalized_support.opacity_filter.cutoff,null);
});
test('SNS-O-06 tint eligibility requires current opacity only when filter enabled',()=>{
    const cache={data:{centers,opacities:attrs.opacity},density,snsMask:attrs.snsMask,snsDetails:{k:3,min_neighbors:1},snsParameters:{k:3,m:1},opacityEncoding:'linear',analyzedOpacityEncoding:'linear',opacityMode:'restrict-sns',opacityThreshold:.25};
    assert.equal(__testing.methodTintEligible('sns',cache),true);
    assert.equal(__testing.methodTintEligible('sns',{...cache,opacityEncoding:'logit'}),false);
    assert.equal(__testing.methodTintEligible('sns',{...cache,opacityThreshold:NaN}),false);
    assert.equal(__testing.methodTintEligible('sns',{...cache,data:{centers}}),false);
    assert.equal(__testing.methodTintEligible('sns',{...cache,data:{centers},opacityMode:'off'}),true);
});

test('SNS-O-08 equal threshold subset, optimized model zero candidates, both modes reject empty/invalid values',()=>{
    for(const threshold of [0,.125,.25,.5,1]) {
        const restricted=select({opacityThreshold:threshold});
        const independent=select({snsEnabled:false,opacityMode:'independent',opacityThreshold:threshold});
        assert.ok(restricted.candidates.every((v,i)=>v<=independent.candidates[i]));
    }
    const high={...attrs,opacity:Float32Array.of(.5,.6,.75,.8,.9,1)};
    assert.equal(select({opacityThreshold:.5},high).candidateCount,0);
    assert.equal(select({snsEnabled:false,opacityMode:'independent',opacityThreshold:.5},high).candidateCount,0);
    for(const value of [NaN,Infinity,-.1,1.1,'',null,undefined])
        assert.throws(()=>select({opacityMode:'independent',opacityThreshold:value}),/Opacity threshold/);
    assert.throws(()=>select({opacityMode:'invalid'}),/Invalid opacity mode/);
    assert.deepEqual([...select({snsEnabled:false,opacityMode:'restrict-sns',opacityEnabled:true},{opacity:null}).candidates],Array(6).fill(0));
});
