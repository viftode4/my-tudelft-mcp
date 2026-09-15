import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExamPlanning, timetableConflicts } from '../src/exam-planning.js';
const event = (id: string, start: string, end: string, extra = {}) => ({ id, title: id, start, end, allDay: false, status: 'CONFIRMED', location: 'Room A', sourceUrl: 'https://mytimetable.tudelft.nl/schedule', ...extra });
const a=event('a','2026-10-01T10:00:00Z','2026-10-01T11:00:00Z');
test('conflicts compare instants and exclude touching intervals, cancellations and all-day notices', () => {
 const result=timetableConflicts([a,event('b','2026-10-01T12:30:00+02:00','2026-10-01T13:30:00+02:00'),event('c','2026-10-01T11:30:00Z','2026-10-01T12:00:00Z'),{...a,id:'cancel',status:'CANCELLED'},{...a,id:'day',allDay:true}]);
 assert.equal(result.items.length,1);assert.equal(result.items[0]?.overlapMinutes,30);assert.equal(result.excludedAllDay,1);
});
test('invalid timetable intervals fail rather than imply no clashes', () => {
 assert.throws(()=>timetableConflicts([{...a,end:'invalid'}]),{code:'TIMETABLE_FORMAT_CHANGED'});
 assert.throws(()=>timetableConflicts([{...a,end:a.start}]),{code:'TIMETABLE_FORMAT_CHANGED'});
});
test('conflicts are capped with explicit incomplete coverage', () => {
 const result=timetableConflicts(Array.from({length:25},(_,i)=>({...a,id:String(i)}))); assert.equal(result.items.length,200);assert.equal(result.complete,false);
});
function fixture(){let account='one';const calls: number[]=[];return {calls,switch:()=>{account='two';},identity:async()=>({id:account}),study:{registrations:async(_kind:string,{offset}:any)=>{calls.push(offset);return {items:[{id:'registered'}],hasMore:false,complete:true};},available:async()=>({items:[{id:'available'}],hasMore:false,complete:true})},timetable:{events:async()=>({items:[a],complete:true,warnings:[]})}};}
test('planning preserves separate registered and offered exams with on-demand scope',async()=>{const f=fixture();const p=new ExamPlanning(f.study as any,f.timetable as any,f.identity);const r=await p.overview('2026-10-01T00:00:00Z','2026-10-02T00:00:00Z');assert.equal(r.registeredExams.complete,true);assert.equal(r.conflicts?.items.length,0);assert.equal(r.backgroundRemindersEnabled,false);assert.deepEqual(f.calls,[0]);});
test('one unavailable service does not conceal the others',async()=>{const f=fixture();f.timetable.events=async()=>{throw new Error('private URL token');};const r=await new ExamPlanning(f.study as any,f.timetable as any,f.identity).overview('2026-10-01T00:00:00Z','2026-10-02T00:00:00Z');assert.equal(r.complete,false);assert.equal(r.conflicts,null);assert.equal(r.registeredExams.items.length,1);assert.doesNotMatch(JSON.stringify(r),/private URL token/);});
test('account switching aborts the combined response',async()=>{const f=fixture();f.timetable.events=async()=>{f.switch();return {items:[a],complete:true,warnings:[]};};await assert.rejects(new ExamPlanning(f.study as any,f.timetable as any,f.identity).overview('2026-10-01T00:00:00Z','2026-10-02T00:00:00Z'),{code:'ACCOUNT_CHANGED'});});
test('exam lists follow pagination and report a bounded continuation',async()=>{const f=fixture();f.study.registrations=async(_kind,{offset}:any)=>({items:Array.from({length:100},(_,i)=>({id:offset+i})),hasMore:true,complete:false,nextOffset:offset+100});const r=await new ExamPlanning(f.study as any,f.timetable as any,f.identity).overview('2026-10-01T00:00:00Z','2026-10-02T00:00:00Z');assert.equal(r.registeredExams.items.length,1000);assert.equal(r.registeredExams.nextOffset,1000);assert.equal(r.complete,false);});
test('malformed exam pagination is reported, not treated as complete',async()=>{const f=fixture();f.study.registrations=async()=>({items:[],hasMore:true,complete:false,nextOffset:0});const r=await new ExamPlanning(f.study as any,f.timetable as any,f.identity).overview('2026-10-01T00:00:00Z','2026-10-02T00:00:00Z');assert.equal(r.registeredExams.error?.code,'MYTU_FORMAT_CHANGED');assert.equal(r.complete,false);});
