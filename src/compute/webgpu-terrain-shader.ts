/** Resident full landscape solver. Basin conditioning is a converged minimax
 * level set, never solid fill. Dependency queues run inside ONE workgroup so
 * storageBarrier provides a real publication barrier; cross-workgroup atomic
 * flags alone cannot safely publish floating-point tributary data in WGSL. */
export const TERRAIN_EROSION_SHADER = /* wgsl */ `
struct Parameters { columns:u32, rows:u32, count:u32, mode:u32, cell:f32, dt:f32, diffusion:f32, sea:f32, flags:u32, iteration:u32, pad0:u32, pad1:u32 }
struct Cell {
 z:f32, loose:f32, cumulative:f32, incised:f32, relaxed:f32, detached:f32, flow:i32, area:u32,
 inherited:f32, indegree:atomic<u32>, firstFlow:i32, load:f32, water:f32,
 source:f32, deposited:f32, exported:f32, reentrained:f32, marine:f32, terrestrial:f32, lake:f32,
 hillrock:f32, hilltransfer:f32, uplift:f32, incision:f32, diffusionNet:f32, square:f32, componentBoundary:atomic<u32>, pad1:f32
}
struct Route { h:f32, d:u32, ocean:u32, pad:u32 }
struct Faces { sediment:array<f32,8>, water:array<f32,8> }
@group(0) @binding(0) var<uniform> p:Parameters;
@group(0) @binding(1) var<storage,read> input:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read_write> cells:array<Cell>;
@group(0) @binding(3) var<storage,read_write> routeIn:array<Route>;
@group(0) @binding(4) var<storage,read_write> routeOut:array<Route>;
@group(0) @binding(5) var<storage,read_write> queue:array<u32>;
@group(0) @binding(6) var<storage,read_write> control:array<atomic<u32>>;
@group(0) @binding(7) var<storage,read_write> faces:array<Faces>;
const INF=1e30; const FAR=0x3fffffffu;
override QUEUE_WORKERS:u32=256u;
const OFF=array<vec2<i32>,8>(vec2(-1,-1),vec2(0,-1),vec2(1,-1),vec2(-1,0),vec2(1,0),vec2(-1,1),vec2(0,1),vec2(1,1));
const FACET=array<vec4<i32>,8>(vec4(1,0,1,1),vec4(0,1,1,1),vec4(0,1,-1,1),vec4(-1,0,-1,1),vec4(-1,0,-1,-1),vec4(0,-1,-1,-1),vec4(0,-1,1,-1),vec4(1,0,1,-1));
fn valid(x:i32,y:i32)->bool{return x>=0&&y>=0&&x<i32(p.columns)&&y<i32(p.rows);}
fn neighbor(i:u32,d:u32)->i32{let xy=vec2<i32>(i32(i%p.columns),i32(i/p.columns))+OFF[d];if(!valid(xy.x,xy.y)){return -1;}return xy.y*i32(p.columns)+xy.x;}
fn boundary(i:u32)->bool{return i%p.columns==0u||i%p.columns+1u==p.columns||i<p.columns||i+p.columns>=p.count;}
fn bed(i:u32)->f32{if(p.mode==1u){return cells[i].relaxed;}return cells[i].z;}
fn higher(a:u32,b:u32)->bool{return routeIn[a].h>routeIn[b].h||(routeIn[a].h==routeIn[b].h&&(routeIn[a].d>routeIn[b].d||(routeIn[a].d==routeIn[b].d&&a>b)));}
fn earlier(a:u32,b:u32)->bool{return higher(a,b)||(routeIn[a].h==routeIn[b].h&&routeIn[a].d==routeIn[b].d&&a>b);}
fn append(i:u32){let q=atomicAdd(&control[1],1u);if(q<p.count){queue[q]=i;}else{atomicOr(&control[6],1u);}}
@compute @workgroup_size(128) fn initialize(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=p.count){return;}cells[i].z=input[i].x;cells[i].flow=-1;cells[i].firstFlow=-1;atomicMax(&control[4],bitcast<u32>(max(0.0,input[i].x)));}
@compute @workgroup_size(1) fn resetChanged(){atomicStore(&control[3],0u);atomicStore(&control[5],0u);}
@compute @workgroup_size(1) fn resetQueue(){atomicStore(&control[0],0u);atomicStore(&control[1],0u);}
@compute @workgroup_size(128) fn initializeFlood(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=p.count){return;}let z=bed(i);let h=select(bitcast<f32>(atomicLoad(&control[4]))+1.0,z,boundary(i));routeIn[i]=Route(h,FAR,select(0u,1u,boundary(i)&&z<=p.sea),0u);}
// Any existing outlet path remains a valid escape path after bed change.
// Its maximum NEW bed height is a rigorous upper bound for the new minimax
// solution, including raised spillways. Pointer doubling computes that bound
// without assuming that old spill heights or old wet/dry labels remain valid.
@compute @workgroup_size(128) fn initializeWarmFlood(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=p.count){return;}let receiver=cells[i].flow;if(receiver<0&&!boundary(i)){atomicOr(&control[6],32u);}routeIn[i]=Route(bed(i),select(p.count,u32(receiver),receiver>=0&&!boundary(i)),0u,0u);}
@compute @workgroup_size(128) fn jumpWarmFlood(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=p.count){return;}var value=routeIn[i];if(value.d<p.count){let next=routeIn[value.d];value.h=max(value.h,next.h);value.d=next.d;}routeOut[i]=value;}
fn oceanRoot(cell:u32)->u32{var root=cell;loop{let parent=atomicLoad(&cells[root].indegree);if(parent==root||parent>=p.count){return parent;}root=parent;}}
@compute @workgroup_size(128) fn initializeOcean(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<p.count){atomicStore(&cells[i].indegree,select(p.count,i,bed(i)<=p.sea));atomicStore(&cells[i].componentBoundary,0u);}}
@compute @workgroup_size(128) fn hookOcean(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=p.count||bed(i)>p.sea){return;}for(var direction=0u;direction<2u;direction++){let j=select(neighbor(i,4u),neighbor(i,6u),direction==1u);if(j<0||bed(u32(j))>p.sea){continue;}let a=oceanRoot(i);let b=oceanRoot(u32(j));if(a!=b){atomicMin(&cells[max(a,b)].indegree,min(a,b));atomicOr(&control[5],1u);}}}
@compute @workgroup_size(128) fn jumpOcean(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<p.count){let parent=atomicLoad(&cells[i].indegree);if(parent<p.count){atomicMin(&cells[i].indegree,atomicLoad(&cells[parent].indegree));}}}
@compute @workgroup_size(128) fn markOceanBoundary(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<p.count&&boundary(i)&&bed(i)<=p.sea){let root=oceanRoot(i);if(root<p.count){atomicOr(&cells[root].componentBoundary,1u);}}}
@compute @workgroup_size(128) fn finishOcean(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<p.count){var ocean=0u;if(bed(i)<=p.sea){let root=oceanRoot(i);if(root<p.count){ocean=atomicLoad(&cells[root].componentBoundary);}}routeIn[i].ocean=ocean;}}
var<workgroup> ha:array<f32,324>;var<workgroup> hb:array<f32,324>;
var<workgroup> oa:array<u32,324>;var<workgroup> ob:array<u32,324>;
var<workgroup> da:array<u32,324>;var<workgroup> db:array<u32,324>;
@compute @workgroup_size(16,16) fn floodTile(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_id) local:vec3<u32>,@builtin(local_invocation_index) lane:u32){
 for(var k=lane;k<324u;k+=256u){let xy=vec2<i32>(group.xy*16u)+vec2<i32>(i32(k%18u)-1,i32(k/18u)-1);var h=INF;var o=0u;if(valid(xy.x,xy.y)){let j=u32(xy.y)*p.columns+u32(xy.x);h=routeIn[j].h;o=routeIn[j].ocean;}ha[k]=h;hb[k]=h;oa[k]=o;ob[k]=o;}
 workgroupBarrier();let xy=group.xy*16u+local.xy;let k=(local.y+1u)*18u+local.x+1u;let good=xy.x<p.columns&&xy.y<p.rows;let i=xy.y*p.columns+xy.x;var z=INF;if(good){z=bed(i);}
 for(var iteration=0u;iteration<16u;iteration++){
  var h=ha[k];var o=oa[k];if(good&&boundary(i)){h=z;}else if(good){var minimum=INF;for(var d=0u;d<8u;d++){let off=OFF[d];minimum=min(minimum,ha[u32(i32(k)+off.y*18+off.x)]);}h=min(h,max(z,minimum));}
  hb[k]=h;ob[k]=o;workgroupBarrier();ha[k]=hb[k];oa[k]=ob[k];workgroupBarrier();
 }
 if(good){let previous=routeIn[i];routeOut[i]=Route(ha[k],FAR,oa[k],0u);if(ha[k]!=previous.h||oa[k]!=previous.ocean){atomicOr(&control[3],1u);}}
}
@compute @workgroup_size(128) fn initializeDistance(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=p.count){return;}var outlet=boundary(i);if(outlet&&routeIn[i].h!=bed(i)){atomicOr(&control[6],64u);}for(var d=0u;d<8u;d++){let j=neighbor(i,d);if(j>=0&&routeIn[u32(j)].h<routeIn[i].h){outlet=true;}}routeIn[i].d=select(FAR,0u,outlet);}
@compute @workgroup_size(16,16) fn distanceTile(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_id) local:vec3<u32>,@builtin(local_invocation_index) lane:u32){
 for(var k=lane;k<324u;k+=256u){let xy=vec2<i32>(group.xy*16u)+vec2<i32>(i32(k%18u)-1,i32(k/18u)-1);var h=INF;var distance=FAR;if(valid(xy.x,xy.y)){let j=u32(xy.y)*p.columns+u32(xy.x);h=routeIn[j].h;distance=routeIn[j].d;}ha[k]=h;da[k]=distance;db[k]=distance;}
 workgroupBarrier();let xy=group.xy*16u+local.xy;let k=(local.y+1u)*18u+local.x+1u;let good=xy.x<p.columns&&xy.y<p.rows;let i=xy.y*p.columns+xy.x;
 for(var iteration=0u;iteration<16u;iteration++){var distance=da[k];for(var d=0u;d<8u;d++){let off=OFF[d];let j=u32(i32(k)+off.y*18+off.x);if(ha[j]==ha[k]){distance=min(distance,da[j]+1u);}}db[k]=distance;workgroupBarrier();da[k]=db[k];workgroupBarrier();}
 if(good){routeOut[i]=Route(routeIn[i].h,da[k],routeIn[i].ocean,0u);if(da[k]!=routeIn[i].d){atomicOr(&control[3],1u);}}
}
@compute @workgroup_size(128) fn initializeSources(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=p.count){return;}var degree=0u;for(var d=0u;d<8u;d++){let j=neighbor(i,d);if(j>=0&&higher(u32(j),i)){degree++;}}atomicStore(&cells[i].indegree,degree);if(degree==0u){append(i);}}
var<workgroup> batchStart:u32;var<workgroup> batchEnd:u32;
fn batch(lane:u32){if(lane==0u){batchStart=atomicLoad(&control[0]);batchEnd=min(batchStart+QUEUE_WORKERS,atomicLoad(&control[1]));atomicStore(&control[0],batchEnd);}}
fn releaseLower(i:u32){for(var d=0u;d<8u;d++){let j=neighbor(i,d);if(j>=0&&higher(i,u32(j))&&atomicSub(&cells[u32(j)].indegree,1u)==1u){append(u32(j));}}}
@compute @workgroup_size(QUEUE_WORKERS) fn routeLTD(@builtin(local_invocation_index) lane:u32){
 loop{batch(lane);workgroupBarrier();let first=workgroupUniformLoad(&batchStart);let last=workgroupUniformLoad(&batchEnd);if(first==last){break;}let enabled=first+lane<last;var i=0u;
  if(enabled){i=queue[first+lane];var area=1u;var inherited=0.0;var largest=0u;var tributary=0u;for(var d=0u;d<8u;d++){let j=neighbor(i,d);if(j>=0&&higher(u32(j),i)&&cells[u32(j)].flow==i32(i)){let count=cells[u32(j)].area;area+=count;if(count>largest||(count==largest&&earlier(u32(j),tributary))){largest=count;tributary=u32(j);inherited=cells[u32(j)].inherited;}}}
   let x=i32(i%p.columns);let y=i32(i/p.columns);let height=routeIn[i].h;var best=-1;var slope=0.0;var flat=routeIn[i].d;
   for(var d=0u;d<8u;d++){let j=neighbor(i,d);if(j<0){continue;}let delta=OFF[d];let drop=height-routeIn[u32(j)].h;let s=drop/select(1.0,1.4142135623730951,delta.x!=0&&delta.y!=0);if(s>slope+1e-8){slope=s;best=j;}else if(slope<1e-8&&drop==0.0&&routeIn[u32(j)].d<flat){flat=routeIn[u32(j)].d;best=j;}}
   var bestSlope=0.0;var cardinal=-1;var diagonal=-1;var unit=vec2<f32>(0.0);var cdir=vec2<f32>(0.0);var ddir=vec2<f32>(0.0);
   for(var f=0u;f<8u;f++){let facet=FACET[f];if(!valid(x+facet.x,y+facet.y)||!valid(x+facet.z,y+facet.w)){continue;}let a=(y+facet.y)*i32(p.columns)+x+facet.x;let b=(y+facet.w)*i32(p.columns)+x+facet.z;let s1=height-routeIn[u32(a)].h;let s2=routeIn[u32(a)].h-routeIn[u32(b)].h;var ca=a;var cb=b;var v=vec2<f32>(0.0);var s=0.0;
    if(s2<=0.0){cb=a;s=s1;v=vec2<f32>(facet.xy);}else if(s2>=s1){ca=b;s=(height-routeIn[u32(b)].h)/1.4142135623730951;v=vec2<f32>(facet.zw)/1.4142135623730951;}else{s=length(vec2(s1,s2));v=(s1*vec2<f32>(facet.xy)+s2*vec2<f32>(facet.zw-facet.xy))/s;}
    if(s>bestSlope+1e-8){bestSlope=s;cardinal=ca;diagonal=cb;unit=v;cdir=select(vec2<f32>(facet.zw),vec2<f32>(facet.xy),ca==a);ddir=select(vec2<f32>(facet.xy),vec2<f32>(facet.zw),cb==b);}
   }
   var residual=0.0;if(bestSlope>1e-8&&cardinal>=0&&diagonal>=0&&higher(i,u32(cardinal))&&higher(i,u32(diagonal))){let a=inherited+(unit.x*cdir.y-unit.y*cdir.x)*p.cell;let b=inherited+(unit.x*ddir.y-unit.y*ddir.x)*p.cell;if(abs(a)<=abs(b)){best=cardinal;residual=a;}else{best=diagonal;residual=b;}}
   cells[i].flow=best;cells[i].area=area;cells[i].inherited=residual;if(p.iteration==0u&&p.mode==0u){cells[i].firstFlow=best;}
  }
  storageBarrier();if(enabled){releaseLower(i);}storageBarrier();
 }
 if(lane==0u&&atomicLoad(&control[0])!=p.count){atomicOr(&control[6],4u);}
}
@compute @workgroup_size(128) fn initializeReceivers(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<p.count&&cells[i].flow<0){append(i);}}
@compute @workgroup_size(QUEUE_WORKERS) fn incision(@builtin(local_invocation_index) lane:u32){
 loop{batch(lane);workgroupBarrier();let first=workgroupUniformLoad(&batchStart);let last=workgroupUniformLoad(&batchEnd);if(first==last){break;}let enabled=first+lane<last;var i=0u;if(enabled){i=queue[first+lane];let uplift=input[i].y*p.dt;let raised=cells[i].z+uplift;var z=raised;let receiver=cells[i].flow;
   if(!boundary(i)&&cells[i].z>p.sea&&receiver>=0&&routeIn[i].h-cells[i].z<=.01){let j=u32(receiver);let diagonal=i%p.columns!=j%p.columns&&i/p.columns!=j/p.columns;let horizontal=p.cell*select(1.0,1.4142135623730951,diagonal);let level=max(p.sea,max(cells[j].incised,select(-INF,routeIn[j].h,routeIn[j].h-cells[j].z>.01)));let k=p.dt*input[i].z*sqrt(f32(cells[i].area)*p.cell*p.cell)/horizontal;if(raised>level){z=min(raised,(raised+k*level)/(1.0+k));}}
   let removed=raised-z;let reentrained=min(cells[i].loose,removed);cells[i].loose-=reentrained;cells[i].incised=z;cells[i].detached=select(0.0,removed,(p.flags&1u)!=0u);cells[i].source+=removed-reentrained;cells[i].reentrained+=reentrained;cells[i].uplift+=uplift;cells[i].incision+=removed;cells[i].cumulative+=removed;if((p.flags&1u)==0u){cells[i].exported+=removed;}
  }storageBarrier();if(enabled){for(var d=0u;d<8u;d++){let j=neighbor(i,d);if(j>=0&&cells[u32(j)].flow==i32(i)){append(u32(j));}}}storageBarrier();
 }if(lane==0u&&atomicLoad(&control[0])!=p.count){atomicOr(&control[6],8u);}
}
@compute @workgroup_size(128) fn hillslope(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=p.count){return;}let z=cells[i].incised;var outgoing=0.0;var incoming=0.0;for(var d=0u;d<8u;d++){let offset=OFF[d];if(offset.x!=0&&offset.y!=0){continue;}let j=neighbor(i,d);if(j<0){continue;}let other=cells[u32(j)].incised;if(z>other&&z>p.sea){outgoing+=p.diffusion*(z-other);}else if(other>z&&other>p.sea){incoming+=p.diffusion*(other-z);}}
 let removed=min(cells[i].loose,outgoing);cells[i].loose=cells[i].loose-removed+incoming;cells[i].relaxed=z+incoming-outgoing;cells[i].source+=outgoing-removed;cells[i].hillrock+=outgoing-removed;cells[i].hilltransfer+=outgoing;cells[i].diffusionNet+=cells[i].relaxed-z;
 atomicMax(&control[4],bitcast<u32>(max(0.0,cells[i].relaxed)));
}
@compute @workgroup_size(128) fn clearFaces(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=p.count){return;}for(var d=0u;d<8u;d++){faces[i].sediment[d]=0.0;faces[i].water[d]=0.0;}}
@compute @workgroup_size(QUEUE_WORKERS) fn sediment(@builtin(local_invocation_index) lane:u32){
 loop{batch(lane);workgroupBarrier();let first=workgroupUniformLoad(&batchStart);let last=workgroupUniformLoad(&batchEnd);if(first==last){break;}let enabled=first+lane<last;var i=0u;if(enabled){i=queue[first+lane];var load=cells[i].detached;var water=1.0;for(var d=0u;d<8u;d++){let j=neighbor(i,d);if(j>=0&&higher(u32(j),i)){load+=faces[u32(j)].sediment[7u-d];water+=faces[u32(j)].water[7u-d];}}
   var weights:array<f32,8>;var sum=0.0;var lastReceiver=0u;for(var d=0u;d<8u;d++){let j=neighbor(i,d);var weight=0.0;if(j>=0){let o=OFF[d];let gradient=(routeIn[i].h-routeIn[u32(j)].h)/(p.cell*select(1.0,1.4142135623730951,o.x!=0&&o.y!=0));if(gradient>1e-10){weight=gradient;lastReceiver=d;}}weights[d]=weight;sum+=weight;}
   if(sum==0.0&&cells[i].flow>=0){for(var d=0u;d<8u;d++){if(neighbor(i,d)==cells[i].flow){weights[d]=1.0;sum=1.0;lastReceiver=d;}}}
   var deposited=0.0;if(boundary(i)||sum==0.0){cells[i].exported+=load;}else{
    let depth=max(0.0,routeIn[i].h-cells[i].relaxed);let marine=routeIn[i].ocean!=0u;let standing=marine||depth>.01;let width=select(min(p.cell,max(1.0,.0048*sqrt(water*p.cell*p.cell))),p.cell,standing);let discharge=.7*water*p.cell*p.cell/width;let fluvial=max(p.cell,.018*discharge*select(1.0,.075,standing));let length=select(fluvial,max(fluvial,.05*max(1.0,p.sea-cells[i].relaxed)/.00004),marine);let attenuation=1.0-exp(-p.cell/length);let accommodation=select(select(p.cell*.025,depth,depth>.01),max(0.0,p.sea-cells[i].relaxed),marine);deposited=min(load*attenuation,accommodation);
    let moved=load-deposited;var sedimentLeft=moved;var waterLeft=water;for(var d=0u;d<8u;d++){if(weights[d]<=0.0){continue;}let fraction=weights[d]/sum;let s=select(min(sedimentLeft,moved*fraction),sedimentLeft,d==lastReceiver);let w=select(min(waterLeft,water*fraction),waterLeft,d==lastReceiver);faces[i].sediment[d]=s;faces[i].water[d]=w;sedimentLeft-=s;waterLeft-=w;}
    cells[i].deposited+=deposited;if(marine){cells[i].marine+=deposited;}else{cells[i].terrestrial+=deposited;if(depth>.01){cells[i].lake+=deposited;}}
   }
   cells[i].loose+=deposited;let next=cells[i].relaxed+deposited;cells[i].square=(next-cells[i].z)*(next-cells[i].z);cells[i].z=next;cells[i].load=load;cells[i].water=water;atomicMax(&control[4],bitcast<u32>(max(0.0,next)));
  }storageBarrier();if(enabled){releaseLower(i);}storageBarrier();
 }if(lane==0u&&atomicLoad(&control[0])!=p.count){atomicOr(&control[6],16u);}
}
@compute @workgroup_size(128) fn finishWithoutSediment(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<p.count){cells[i].square=(cells[i].relaxed-cells[i].z)*(cells[i].relaxed-cells[i].z);cells[i].z=cells[i].relaxed;}}
var<workgroup> sums:array<f32,256>;
@compute @workgroup_size(256) fn summarizeStep(@builtin(local_invocation_index) lane:u32){var sum=0.0;for(var i=lane;i<p.count;i+=256u){sum+=cells[i].square;}sums[lane]=sum;workgroupBarrier();for(var stride=128u;stride>0u;stride/=2u){if(lane<stride){sums[lane]+=sums[lane+stride];}workgroupBarrier();}if(lane==0u){atomicStore(&control[16u+p.iteration],bitcast<u32>(sqrt(sums[0]/f32(p.count))));}}
@compute @workgroup_size(128) fn packPreview(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<p.count){routeOut[i]=Route(cells[i].z,bitcast<u32>(cells[i].loose),0u,0u);}}
`
