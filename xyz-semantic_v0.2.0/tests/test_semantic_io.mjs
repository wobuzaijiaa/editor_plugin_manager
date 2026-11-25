import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSemanticJson } from '../semantic-io.js';
import { newDocument, IDENTITY } from '../semantic-core.js';
const good = newDocument('permanent-id','Building A',[...IDENTITY]);
const file = text => ({ size:text.length, text: async()=>text });
test('SEM-01 explicit file open validates JSON before returning new document', async()=>{
    assert.deepEqual(await readSemanticJson(file(JSON.stringify(good))),good);
    await assert.rejects(readSemanticJson(file('{broken json')),/not valid JSON/);
    await assert.rejects(readSemanticJson(file(JSON.stringify({...good,schema_version:8}))),/schema_version/);
    await assert.rejects(readSemanticJson({size:9*1024*1024,text:async()=>''}),/8 MB/);
});
