import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validatePlan,validateCurve} from '../dist/grading/validator.js';
import {mapPlan} from '../dist/grading/mapper.js';
import {allowedKeys,flatten,fingerprint} from '../dist/grading/settings.js';

const plan=(scalars=[],curves=[])=>({title:'参考风格',analysis:{target:'阴天',reference:'暖色亮部',adaptation:'保留明暗',skin:'不作固定亮度假设'},scalars,curves,warnings:[]});
const scalar=(key,value,mode='absolute')=>({key,value,mode});

test('malformed and unknown model output fail closed',()=>{
  for(const p of [null,{}, {...plan(),extra:true},plan([scalar('CropTop',0.4)]),plan([scalar('Exposure2012',Infinity)])]) assert.throws(()=>validatePlan(p,['Exposure2012']));
});
test('absolute white balance, duplicates and excessive deltas are refused',()=>{
  for(const p of [plan([scalar('Temperature',6500)]),plan([scalar('Tint',5)]),plan([scalar('Temperature',1501,'delta')]),plan([scalar('Tint',31,'delta')]),plan([scalar('Exposure2012',1),scalar('Exposure2012',2)])]) assert.throws(()=>validatePlan(p,['Temperature','Tint','Exposure2012']));
});
test('target-relative exposure and WB blend from existing edit, not zero',()=>{
  const p=validatePlan(plan([scalar('Exposure2012',0.4,'delta'),scalar('Temperature',600,'delta')]),['Exposure2012','Temperature']);
  assert.deepEqual(mapPlan(p,{Exposure2012:1,Temperature:5200},0.5).settings,{Exposure2012:1.2,Temperature:5500});
  assert.deepEqual(mapPlan(p,{Exposure2012:1,Temperature:5200},0).settings,{});
});
test('full strength bounds apply even when a small strength would hide an invalid target',()=>{
  assert.throws(()=>mapPlan(plan([scalar('Exposure2012',4,'delta')]),{Exposure2012:3},0.1),/range/);
  for(const n of [-1,2,NaN,Infinity]) assert.throws(()=>mapPlan(plan(),{},n));
});
test('grading hue follows shortest arc; neutral baseline goes directly to intended hue',()=>{
  const p=plan([scalar('SplitToningShadowHue',10)]);
  assert.equal(mapPlan(p,{SplitToningShadowHue:350,SplitToningShadowSaturation:10},0.5).settings.SplitToningShadowHue,0);
  assert.equal(mapPlan(plan([scalar('SplitToningShadowHue',200)]),{SplitToningShadowHue:0,SplitToningShadowSaturation:0},0.5).settings.SplitToningShadowHue,200);
});
test('curve blends at union of control points rather than by array index',()=>{
  const p=validatePlan(plan([],[{key:'ToneCurvePV2012',points:[0,10,128,140,255,250]}]),['ToneCurvePV2012']);
  const actual=mapPlan(p,{ToneCurvePV2012:[0,0,64,60,255,255]},0.5).settings.ToneCurvePV2012;
  assert.deepEqual(actual,[0,5,64,68,128,133,255,253]);
});
test('folded curves, missing endpoints, odd arrays and duplicate x are rejected',()=>{
  for(const points of [[0,0,255],[0,0,0,10,255,255],[0,255,255,0],[10,10,255,255],[0,0,255,256]]) assert.throws(()=>validateCurve(points));
});
test('live capability intersection removes missing calibration and JPEG WB',()=>{
  assert.deepEqual(allowedKeys(['Exposure2012','RedHue','Temperature','CropTop'],{Exposure2012:0,Temperature:0,CropTop:0}),['Exposure2012']);
  const data={exposure:1,hsl:{HueAdjustmentBlue:-10},colorGrading:{ColorGradeMidtoneSat:4},toneCurve:[0,0,255,255]};
  assert.deepEqual(flatten(data),{Exposure2012:1,HueAdjustmentBlue:-10,ColorGradeMidtoneSat:4,ToneCurvePV2012:[0,0,255,255]});
  const p={id:1,path:'x',developSettings:{exposure:0,contrast:1}};
  assert.equal(fingerprint(p),fingerprint({...p,developSettings:{contrast:1,exposure:0}}));
  assert.notEqual(fingerprint(p),fingerprint({...p,developSettings:{exposure:1,contrast:1}}));
});
