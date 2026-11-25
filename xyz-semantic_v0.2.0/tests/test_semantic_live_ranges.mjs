import { test } from 'node:test';
import assert from 'node:assert/strict';
import { semanticYFromWorldRange, worldYFromSemanticRange } from '../semantic-ui.js';

test('SEM-18 full/view/slice live Y linking is reversible across model translation and scale', () => {
    // Column-major affine matrix: the user-defined semantic floor plane is Y-up.
    const modelWorld=[2,0,0,0, 0,2,0,0, 0,0,2,0, 12,20,-3,1];
    for(const interval of [{min:-.381,max:2.9},{min:0,max:2.7},{min:1.1,max:1.5}]) {
        const world=worldYFromSemanticRange(interval,modelWorld);
        const local=semanticYFromWorldRange(world,modelWorld);
        assert(Math.abs(local.min-interval.min)<1e-10);
        assert(Math.abs(local.max-interval.max)<1e-10);
    }
});

test('SEM-19 invalid/tilted live Y geometry fails closed instead of silently creating a floor', () => {
    const tilt=[1,0,0,0, 0,.7071,.7071,0, 0,-.7071,.7071,0, 0,0,0,1];
    assert.throws(()=>worldYFromSemanticRange({min:2,max:2},[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),/Invalid semantic/);
    assert.throws(()=>worldYFromSemanticRange({min:0,max:2},tilt),/not aligned/);
});
