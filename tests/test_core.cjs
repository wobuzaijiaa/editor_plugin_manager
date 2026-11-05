const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../external/custom-editor.js'), 'utf8');
const ctx = vm.createContext({console, Float32Array, Float64Array, Uint8Array, Uint32Array, TextEncoder,
  Number, Array, Map, Set, Error, Promise, setTimeout, clearTimeout, performance});
vm.runInContext(source.split('async function initialize()')[0] +
  '\n;globalThis.api={interval, display3, axisDomain, withinXYZ, indicesFromPredicate, matMul4, toRows, readWorldCenters, PreviewMask, commonMapping, captureSnapshot, snapshotView, sectionMetadata, snapshotFolderName, saveSnapshotFiles};',ctx);
const { interval, display3, axisDomain, withinXYZ, indicesFromPredicate, matMul4, toRows, readWorldCenters, PreviewMask, commonMapping, captureSnapshot, snapshotView, sectionMetadata, snapshotFolderName, saveSnapshotFiles } = ctx.api;
function matrix(data) {return {data:Float32Array.from(data),clone(){return matrix(this.data);},mul2(a,b){this.data.set(matMul4(a.data,b.data));return this;},equals(b){return this.data.every((x,i)=>x===b.data[i]);}};}
const ID=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const TR=[1,0,0,0,0,1,0,0,0,0,1,0,2,10,5,1];
const scene={};
const flags=Uint8Array.from([1,3,1]);
const inst={flags,count:3,sourceRow:Uint32Array.from([2,1,0]),palette:Uint32Array.from([0,0,0]),transformIndex(){return 0;},
  setBits(r,b){r.forEach(i=>this.flags[i]|=b);},clearBits(r,b){r.forEach(i=>this.flags[i]&=~b);},flush(){}};
const splat={scene,visible:true,instances:inst,worldTransform:matrix(ID),transformPalette:{getTransform(id,out){out.data.set(TR);}},
  resource:{sourcePool:{acquire(p,l,n){return {data:new ArrayBuffer(n*3*4),release(){}};}},source:{meta:{chunkSize:2,layouts:{position:{}}},async read({indices,indexOffset,count,position}) {
    const pts=[[0,20,0],[10,30,10],[20,40,20]];const xyz=new Float32Array(position.data);
    for(let i=0;i<count;i++) xyz.set(pts[indices[indexOffset+i]],3*i);
  }}}};
(async()=>{
  assert.equal(display3(-4.160118),'-4.160');
  const t=Math.SQRT1_2;
  assert.equal(snapshotView({x:0,y:t,z:0,w:t}).direction,'-X');
  assert.equal(snapshotView({x:-t,y:0,z:0,w:t}).direction,'-Y');
  assert.equal(snapshotView({x:0,y:0,z:0,w:1}).direction,'-Z');
  assert.equal(snapshotView({x:0,y:-t,z:0,w:t}).direction,'+X');
  assert.equal(snapshotView({x:t,y:0,z:0,w:t}).direction,'+Y');
  assert.equal(snapshotView({x:0,y:1,z:0,w:0}).direction,'+Z');
  assert.equal(snapshotView({x:0,y:0,z:Math.sin(Math.PI/8),w:Math.cos(Math.PI/8)}).axis,'Z', 'roll preserves viewing axis');
  assert.equal(snapshotView({x:0,y:Math.sin(Math.PI/8),z:0,w:Math.cos(Math.PI/8)}).axis,null, 'oblique view not misreported as cardinal');

  assert.equal(display3(0.255285),'0.255');
  assert.equal(display3(-0.0000001),'0.000');
  assert.deepEqual({...interval(0,0)},{min:0,max:0});
  assert.throws(()=>interval(1,0));
  const centers=await readWorldCenters(splat);
  assert.deepEqual([...centers.x],[22,12,2]);
  assert.deepEqual([...centers.y],[50,40,30]);
  assert.deepEqual([...centers.z],[25,15,5]);
  assert.deepEqual({...axisDomain([centers.x]).full},{min:2,max:22});
  assert.deepEqual({...axisDomain([centers.y],true).focus},{min:30,max:50});
  const bounds={x:{min:10,max:22},y:{min:40,max:50},z:{min:10,max:25}};
  assert(withinXYZ(centers,0,bounds));
  assert(withinXYZ(centers,1,bounds));
  assert(!withinXYZ(centers,2,bounds));
  const mask=new PreviewMask(splat,centers);
  mask.verify(scene);mask.apply(bounds);mask.verify(scene);
  assert.deepEqual([...flags],[1,3,3]);
  mask.restore();assert.deepEqual([...flags],[1,3,1]);
  mask.apply({x:{min:22,max:22},y:{min:50,max:50},z:{min:25,max:25}});
  assert.deepEqual([...flags],[1,3,3],'zero-width combined interval');
  mask.restore();
  flags[0] |= 4;assert.throws(()=>mask.verify(scene));flags[0]=1;
  assert(commonMapping([splat]));
  assert.deepEqual([...matMul4(ID,TR)],TR);
  assert.deepEqual([...toRows(TR)[0]],[1,0,0,2]);
  const index=[];indicesFromPredicate(5,i=>i!==2).forEach(i=>index.push(i));assert.deepEqual(index,[0,1,3,4]);
  // Mock the browser directory picker’s File System Access handles.
  const savedFolders = new Map();
  const parent = {
    async getDirectoryHandle(name, options = {}) {
      let folder = savedFolders.get(name);
      if (!folder) {
        if (!options.create) throw Object.assign(new Error('Not found'), { name: 'NotFoundError' });
        folder = {
          files: new Map(),
          async getFileHandle(filename, options = {}) {
            if (!this.files.has(filename) && !options.create)
              throw Object.assign(new Error('Not found'), { name: 'NotFoundError' });
            return {
              createWritable: async () => ({
                write: async bytes => { folder.files.set(filename, Uint8Array.from(bytes)); },
                close: async () => {}, abort: async () => {}
              })
            };
          }
        };
        savedFolders.set(name, folder);
      }
      return folder;
    }
  };
  assert.equal(snapshotFolderName('Level 1 / East', new Date('2026-11-04T10:19:31.123Z')),
    'topdown_Level_1_East_20261104T101931123Z');
  assert.equal(snapshotFolderName('', new Date('2026-11-04T10:19:31.123Z')),
    'topdown_unlabeled_20261104T101931123Z');
  const callbacks=new Map(),passes=[];
  const scene2={__customCaptureBusy:false,events:{functions:new Map([['render.image',true]]),
    on(event,fn){callbacks.set(event,fn);return{off(){callbacks.delete(event);}};},
    async invoke(event,settings,sink){assert.equal(event,'render.image');assert.equal(settings.format,'png');
      callbacks.get('postrender')();await sink.write(Uint8Array.from([137,80,78,71,...Array(25).fill(0)]));await sink.close();return true;}
  },graphicsDevice:{maxTextureSize:8192},gizmoLayer:{enabled:true},centersLayer:{enabled:true},
    camera:{ortho:true,renderOverlays:true,targetSize:{width:1920,height:1080},camera:{clearColor:{clone(){return {r:1,g:1,b:1,a:1,clone(){return {...this};},set(r,g,b,a){this.r=r;this.g=g;this.b=b;this.a=a;},copy(){}};},copy(){}}},
      clearPass:{setClearColor(c){passes.push([c.r,c.g,c.b,c.a]);}},captureFrame(){return {ortho:true,target:{width:1920,height:1080},view:matrix(ID),projection:matrix(ID),position:{x:1,y:2,z:3},rotation:{x:0,y:0,z:0,w:1}};}}
  };
  const snap=await captureSnapshot(scene2,null,1920,1080,parent);
  assert.match(snap.image,/^topdown_unlabeled_\d{8}T\d{9}Z\.png$/);
  assert.equal(snap.snapshot_view.axis,'Z');assert.equal(snap.snapshot_view.direction,'-Z');
  assert.equal(savedFolders.size,1);assert.equal(scene2.__customCaptureBusy,false);
  const firstStem=snap.image.slice(0,-4), firstFolder=savedFolders.get(firstStem);
  assert(firstFolder.files.has(snap.image));
  assert(firstFolder.files.has(`${firstStem}.json`));
  assert.equal(JSON.parse(Buffer.from(firstFolder.files.get(`${firstStem}.json`)).toString()).image,snap.image);
  await assert.rejects(() => saveSnapshotFiles(parent, firstStem, Uint8Array.of(1), snap),
    /already exists/, 'an earlier snapshot must not be overwritten');
  assert.deepEqual(passes.at(-1),[0,0,0,0],'white viewport regression');
  const captureBounds = {x:{min:-7142.14208984375,max:250.72720336914062},
    y:{min:-48.59873580932618,max:134.72601318359372},z:{min:1,max:5}};
  const preview = {ranges:captureBounds,section_id:'Axes Z',model_to_snapshot:toRows(ID),mapping_status:'declared_uniform'};
  const more = await captureSnapshot(scene2,preview,1920,1080,parent);
  assert.equal(more.snapshot_view.axis,'Z');
  assert.match(more.image,/^topdown_Axes_Z_\d{8}T\d{9}Z\.png$/);
  const secondStem=more.image.slice(0,-4);
  const secondFolder=savedFolders.get(secondStem);
  assert(secondFolder.files.has(more.image));
  assert(secondFolder.files.has(`${secondStem}.json`));
  const savedMeta=JSON.parse(Buffer.from(secondFolder.files.get(`${secondStem}.json`)).toString());
  assert.equal(savedMeta.image,more.image);
  assert.equal(savedMeta.portviewer_floor.floor_id,'Axes Z');
  assert.equal(savedFolders.size,2);

  assert.equal(more.portviewer_section.axis,'Z');
  assert.equal(more.portviewer_section.direction,'-Z');
  assert.equal(more.portviewer_section.range_min,1);
  assert.equal(more.portviewer_section.range_max,5);
  assert.equal(more.portviewer_section.section_id,'Axes Z');
  assert.equal(more.portviewer_xyz_filter.y_min,-48.59873580932618);
  assert.equal(more.portviewer_floor.axis,'Z','primary axis follows captured orthographic view');
  assert.equal(more.portviewer_floor.coordinate_frame,'editor_world');
  assert.equal(more.portviewer_floor.z_min,captureBounds.z.min);
  assert.equal(more.portviewer_floor.z_max,captureBounds.z.max);
  assert.equal('y_min' in more.portviewer_floor,false);
  assert.equal(more.portviewer_floor.floor_id,'Axes Z');
  assert.deepEqual(JSON.parse(JSON.stringify(more.portviewer_floor.model_to_snapshot)),JSON.parse(JSON.stringify(toRows(ID))),'legacy PortViewer receives complete mapping for Z snapshot');
  assert.equal(Object.hasOwn(more.portviewer_section, 'model_to_snapshot'), false,
    'section must never duplicate the canonical model transform');
  assert.equal(Object.hasOwn(more.portviewer_section, 'mapping_status'), false,
    'section must never duplicate canonical mapping status');
  assert.equal((JSON.stringify(more).match(/"model_to_snapshot"/g) || []).length, 1,
    'exactly one source-model transform in the complete metadata');
  const Y = snapshotView({x:-t,y:0,z:0,w:t});
  const alongY=sectionMetadata({...preview,section_id:'Axes Y', ranges:{...captureBounds,y:{min:-5,max:-2}}},Y);
  assert.equal(alongY.portviewer_section.axis,'Y');
  assert.equal(alongY.portviewer_section.range_min,-5);
  assert.equal(alongY.portviewer_section.range_max,-2);
  assert.equal(alongY.portviewer_floor.y_min,-5,'Y view preserves Y-floor schema');
  assert.equal(alongY.portviewer_floor.floor_id,'Axes Y');
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(alongY.portviewer_floor))),
    ['version','axis','coordinate_frame','y_min','y_max','floor_id','vertical_confirmed','model_id','association_basis','geometry_validation','model_to_snapshot','mapping_status']);
  const X = snapshotView({x:0,y:t,z:0,w:t});
  const alongX=sectionMetadata(preview,X);
  assert.equal(alongX.portviewer_section.axis,'X');
  assert.equal(alongX.portviewer_section.range_min,captureBounds.x.min);
  assert.equal(alongX.portviewer_section.range_max,captureBounds.x.max);
  assert.equal(alongX.portviewer_floor.axis,'X');
  assert.equal(alongX.portviewer_floor.x_min,captureBounds.x.min);
  assert.equal(alongX.portviewer_floor.x_max,captureBounds.x.max);
  assert.equal('y_min' in alongX.portviewer_floor,false);
  assert.equal(alongX.portviewer_floor.model_to_snapshot[0][0],1);
  const oblique=sectionMetadata(preview, snapshotView({x:0,y:Math.sin(Math.PI/8),z:0,w:Math.cos(Math.PI/8)}));
  assert.equal(oblique.portviewer_section.axis,null);
  assert.equal(oblique.portviewer_section.range_min,null);
  assert.equal(oblique.portviewer_floor.axis,null);
  assert.equal('y_min' in oblique.portviewer_floor,false);
  assert.equal(oblique.portviewer_xyz_filter.z_min,1);
  const missingId=sectionMetadata({...preview,section_id:'   '},Y);
  assert.equal(missingId.portviewer_floor.floor_id,null);
  assert.equal(missingId.portviewer_section.section_id,null);

  console.log('PASS core: world XYZ source/palette transforms, combined mask, zero-width, flag restoration, 3 decimal presentation, view-axis metadata, native snapshot mock');
})().catch(e=>{console.error(e);process.exitCode=1;});
