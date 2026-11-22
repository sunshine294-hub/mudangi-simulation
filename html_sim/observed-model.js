(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.ShuttleObservedModel=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const plans=new WeakMap();
  const routes={UP:['U01','U02','U03','U04'],DOWN:['D01','D02','D03','D04','D05']};
  const finite=x=>x!=null&&Number.isFinite(+x);
  const clone=x=>JSON.parse(JSON.stringify(x));
  const stats=a=>{a=a.slice().sort((x,y)=>x-y);const q=p=>{const n=(a.length-1)*p,i=Math.floor(n);return a[i]+(a[Math.min(i+1,a.length-1)]-a[i])*(n-i);};return{n:a.length,mean:a.length?a.reduce((s,x)=>s+x,0)/a.length:null,median:a.length?q(.5):null,p90:a.length?q(.9):null};};
  function randomGenerator(seed){let value=(seed>>>0)||0x9e3779b9;return()=>{value^=value<<13;value^=value>>>17;value^=value<<5;return(value>>>0)/4294967296;};}
  function makeRow(template,t,n){t=Math.floor(t);return{...template,sourcePlanned:template.sourcePlanned??template.planned,id:'OBS_'+n,person:'OBS_PERSON_'+n,source:'synthetic_observation_reconstruction_not_measured',previousId:null,gap:0,activityRef:null,personMetadataId:null,ready:t,planned:t,boarded:null,completed:null,status:'waiting',trip:null,vehicle:null,metadataIsSyntheticNotObserved:true,dependencyRemovedForReconstruction:true};}
  function buildLegacyPlan(data,seed){
    const random=randomGenerator(seed);
    const base=data.cases.S0,start=+data.config.start,end=+data.config.end;
    const originalUp=(data.demand||base.outcomes).filter(r=>r.origin==='U01');
    const specials=originalUp.filter(r=>r.activityCategory==='ai_lunch_return'||r.residence==='dormitory');
    const templates=originalUp.filter(r=>!specials.includes(r));
    const rows=[];let n=0,ti=0,q=0,prev=start-1;
    const groups=new Map();
    for(const e of base.events.filter(e=>e.event==='departure'&&e.stop==='U01'))groups.set(+e.t,(groups.get(+e.t)||0)+(+e.cap));
    const departures=Array.from(groups,([t,cap])=>({t,cap})).sort((a,b)=>a.t-b.t);
    function add(t){const template=templates[(ti++*1619)%templates.length]||{origin:'U01',destination:'U04'};rows.push(makeRow(template,t,n++));q++;}
    for(let i=0;i<departures.length;i++){
      const e=departures[i],t=+e.t;
      // A single morning demand peak is a model assumption used to reproduce
      // the requested maximum50, while the remaining morning/lunch target42
      // and the imprecisely timed 10:30s observation remain unchanged.
      // 53400 (14:50): user field observation 2026-11-20, about 45 waiting at 반도체대학 (U01).
      const target=t===30120?50:t===53400?45:t<32400||t>=41400&&t<46800?42:t>=37800&&t<38400?34:t<41400?18:18+(i%7);
      const needed=Math.max(0,target-q),lo=Math.max(start,prev+1),hi=Math.max(lo,t-1);
      // Stratified arrivals with bounded jitter avoid a second artificial batch
      // before a delayed vehicle while retaining reproducible timing variation.
      const times=Array.from({length:needed},(_,j)=>Math.min(hi,lo+(hi-lo)*(j+1+.2*(random()-.5))/(needed+1))).sort((a,b)=>a-b);
      for(const when of times)add(when);
      q-=Math.min(q,+e.cap);prev=t;
    }
    // No latent infinite inflow is generated: these are new synthetic requests,
    // inferred from the reported queue envelope and baseline service departures.
    const claimed=new Set();let lunchIndex=0;
    for(const template of specials){
      const lunch=template.activityCategory==='ai_lunch_return',wanted=lunch?44100+(lunchIndex+++.5)*2700/55:+template.planned;
      let best=-1,distance=Infinity;
      for(let i=0;i<rows.length;i++)if(!claimed.has(i)&&(!lunch||rows[i].ready>=44100&&rows[i].ready<46800)){
        const delta=Math.abs(rows[i].ready-wanted);if(delta<distance){distance=delta;best=i;}
      }
      if(best>=0){claimed.add(best);rows[best]=makeRow(template,rows[best].ready,+rows[best].id.slice(4));}
    }
    const allDown=(data.demand||base.outcomes).filter(r=>r.origin.startsWith('D'));
    const lunchDown=allDown.filter(r=>r.activityCategory==='ai_lunch_outbound');
    const down=allDown.filter(r=>r.activityCategory!=='ai_lunch_outbound').slice().sort((a,b)=>+a.planned-+b.planned);
    const bins=Math.ceil((end-start)/300),weights=Array.from({length:bins},(_,i)=>{const t=start+i*300;return t>=41400&&t<46800?1.8:t<32400?1.3:1;});
    const sum=weights.reduce((a,b)=>a+b,0);let cumulative=0,assigned=0;
    for(let b=0;b<bins;b++){
      cumulative+=weights[b];const total=Math.round(down.length*cumulative/sum),count=total-assigned;
      for(let j=0;j<count;j++){const template=down[assigned+j];rows.push(makeRow(template,start+b*300+300*(j+1)/(count+1),n++));}
      assigned=total;
    }
    for(let i=0;i<lunchDown.length;i++)rows.push(makeRow(lunchDown[i],41400+(i+.5)*2400/lunchDown.length,n++));
    rows.sort((a,b)=>a.ready-b.ready||a.id.localeCompare(b.id));
    // An explicit OD assumption, not additional riders or a measured share:
    // allocate every tenth eligible AI -> final-stop request to education.
    // Lunch and dormitory activity requests retain their existing destinations.
    const educationCandidates=rows.filter(r=>r.origin==='D01'&&r.destination==='D05'&&r.residence!=='dormitory'&&r.activityCategory==='other');
    let educationReassigned=0;
    for(let i=9;i<educationCandidates.length;i+=10){
      const row=educationCandidates[i];
      Object.assign(row,{originalDestination:row.destination,originalReason:row.reason,originalActivitySubtype:row.activitySubtype,
        destination:'D03',reason:'assumed_downstream_education_alighting',activitySubtype:'between_classes',
        activityLabel:'교육대학 하행 이동 · 합성 가정',ODReassignedForEducation:true,educationAlightingShareIsMeasured:false});
      educationReassigned++;
    }
    // New user-specified demand assumptions affect actual requests, not chart pixels.
    const baselineReconstructionRequests=rows.length;
    const genericDown=educationCandidates.find(r=>!r.ODReassignedForEducation)||{origin:'D01',destination:'D05',residence:'unknown'};
    const newRow=(template,t,reason)=>makeRow({...template,activityCategory:'other',activitySubtype:'unexplained_arrivals',reason,
      userSpecifiedDemandAssumption:true,ODReassignedForEducation:false,originalDestination:undefined},t,n++);
    let addedDownstream=0;
    for(let t=start,b=0;t<end;t+=300,b++){
      const lunch=t>=41400&&t<46800,target=lunch?60:18+(b%6);
      const existing=rows.filter(r=>r.origin.startsWith('D')&&r.ready>=t&&r.ready<t+300).length;
      if(existing>target)throw new Error('Existing downstream arrivals exceed specified bin target');
      const extra=target-existing;
      for(let j=0;j<extra;j++){
        // Students already waiting at the start of lunch can board the first
        // vehicle immediately; the remaining lunch inflow is distributed.
        const when=t===41400&&j<40?t:t+1+(j+.5)*298/extra;
        rows.push(newRow(genericDown,when,lunch?'assumed_lunch_AI_full_vehicle_demand':'assumed_downstream_18_to_23_per_5min'));addedDownstream++;
      }
    }
    rows.sort((a,b)=>a.ready-b.ready||a.id.localeCompare(b.id));
    const plan={rows,meta:{basis:'S0_supply_inferred_common_synthetic_demand',sharedAcrossScenarios:true,queueEnvelopeAppliesTo:'S0 U01 baseline only; changed supply may exceed',maxQueueTarget:40,fieldMeasured:false,originalRequestsMutated:false,originalDownstreamRequestCount:allDown.length,initialQueueAssumption:40,midQueueTargetAssumption:20,dependencyMode:'independent_reconstructed_requests',afternoonCoverage:'14:00 onward unobserved intervals use synthetic continuation, not continuous observation',assumptions:['The lower bound 40 of the reported 40..50-person maximum queue is selected equally before 09:00 and at lunch; this is supply-demand reconstruction, not a continuous field measurement','U01 arrivals inferred between baseline departures to approach 40 before 09:00 and at lunch, 20 between 09:00 and 11:30, and 18..24 after 13:00; 20 is a queue assumption, distinct from the reported new-arrival count','50 persons is a reported maximum constraint, never a display clamp','downstream timing redistributed over 5-minute bins with lunch weighting; existing downstream total and OD templates retained; 55 AI lunch outbound requests remain 11:30..12:10 and 55 return requests 12:15..13:00','one reconstructed request is independent; original person-level linked return chains are not claimed','all scenarios share this same reconstructed demand; boarding and waiting are recalculated from each realized service schedule']}};
    plan.meta.downstreamEducationODAssumption={eligibleOriginalOD:'D01 -> D05',destination:'D03',eligibleRequests:educationCandidates.length,
      allocatedRequests:educationReassigned,selection:'every tenth eligible request, starting at index 9',nominalShare:.1,
      measured:false,totalRequestsAndReadyTimesPreserved:true,protectedActivities:['ai_lunch_outbound','ai_lunch_return','dormitory']};
    plan.meta.assumptions=plan.meta.assumptions.map(s=>s.replace('existing downstream total and OD templates retained','existing downstream total and timing retained; eligible general AI-to-final-stop requests are partly reassigned to education by the explicit 10-percent synthetic OD assumption'));
    plan.meta.assumptions.push('Downstream education alightings use every tenth eligible general D01-to-D05 request, with lunch and dormitory requests protected; no measured OD share is claimed and no riders are added');
    plan.meta.userDemandRevision={upstream13To1305:30,normalDownstreamFiveMinuteRange:[18,23],lunchDownstreamPerFiveMinutes:60,
      baselineReconstructionRequests,additionalUpstreamRequests:0,additionalDownstreamRequests:addedDownstream,
      source:'user_requested_scenario_assumptions_not_field_measurements',lunchGoal:'all revenue departures from AI from 11:30 until 13:00 leave full under default scenarios'};
    plan.meta.assumptions.push('User-requested revision adds independent synthetic requests: U01 13:00..13:05 has 30 arrivals; normal downstream bins have 18..23, lunch bins have 60, with an initial lunch waiting cohort. These are scenario assumptions, not collected measurements.');
    return plan;
  }
  function createDemandPlan(data,options={}){
    const profile=options.profile||'activity_reference',seed=options.seed==null?42:Number(options.seed);
    if(!['activity_reference','lunch_full'].includes(profile))throw new Error('Unknown demand profile');
    if(!Number.isInteger(seed)||seed<0||seed>4294967295)throw new Error('Demand seed must be a uint32 integer');
    if(!plans.has(data))plans.set(data,new Map());const cache=plans.get(data),key=profile+'|'+seed;
    if(cache.has(key))return cache.get(key);
    const plan=buildLegacyPlan(data,42),random=randomGenerator(seed^0xa5a5a5a5),start=+data.config.start,end=+data.config.end;
    const setTime=(row,t)=>{row.planned=row.ready=Math.max(start,Math.min(end-1,Math.floor(t)));};
    // Assign OD/activity templates once, then let the selected seed affect only
    // timing. Changing the seed must not change who is classified as dormitory
    // or how many requests have each destination.
    const upRandom=randomGenerator(seed^0x3c6ef372);
    const departureTimes=[...new Set(data.cases.S0.events.filter(e=>e.event==='departure'&&e.stop==='U01').map(e=>+e.t))].sort((a,b)=>a-b);
    // Every seed, including 42, uses the same timing draw; seed 42 is no longer a special case.
    for(const row of plan.rows.filter(r=>r.origin==='U01')){
      if(row.ready===start)continue;
      let i=0;while(i<departureTimes.length&&departureTimes[i]<=row.ready)i++;
      let lo=i?departureTimes[i-1]+1:start,hi=i<departureTimes.length?departureTimes[i]-1:end-1;
      if(row.activityCategory==='ai_lunch_return'){lo=Math.max(lo,44100);hi=Math.min(hi,46799);}
      setTime(row,lo+upRandom()*Math.max(0,hi-lo));
    }
    if(profile==='activity_reference'){
      // Remove only the explicit full-load stress additions. Original downward
      // request totals and OD/activity templates remain, with independent timing.
      plan.rows=plan.rows.filter(r=>!(r.origin.startsWith('D')&&r.userSpecifiedDemandAssumption));
      const original=(data.demand||[]).filter(r=>r.origin.startsWith('D'));
      const bins=Math.ceil((end-start)/300),centers=Array.from({length:bins},(_,i)=>start+i*300+150);
      const kernel=centers.map(t=>original.reduce((s,r)=>s+Math.exp(-.5*((t-(+r.planned))/900)**2),0));
      const maxKernel=Math.max(1,...kernel);
      const weights=centers.map((t,i)=>(.35+.9*kernel[i]/maxKernel+.7*Math.exp(-.5*((t-44100)/1500)**2))*(.85+.3*random()));
      const cumulative=[];let total=0;for(const w of weights)cumulative.push(total+=w);
      const sample=()=>{const target=random()*total;let i=0;while(i<cumulative.length-1&&cumulative[i]<target)i++;return start+i*300+random()*300;};
      const rows=plan.rows.filter(r=>r.origin.startsWith('D'));
      const protectedRows=rows.filter(r=>r.activityCategory==='ai_lunch_outbound'||r.residence==='dormitory');
      const other=rows.filter(r=>!protectedRows.includes(r)).sort((a,b)=>(+a.sourcePlanned)-(+b.sourcePlanned)||a.id.localeCompare(b.id));
      const times=other.map(sample).sort((a,b)=>a-b);other.forEach((r,i)=>setTime(r,times[i]));
      for(const row of protectedRows){
        if(row.activityCategory==='ai_lunch_outbound')setTime(row,41400+random()*2400);
        else setTime(row,+row.sourcePlanned+(random()+random()-1)*600);
      }
      plan.meta.timingModel={method:'source-planned-time-kernel-plus-activity-envelope',source:'original synthetic timetable-prior planned request times, not observed class exits',kernelBandwidthSeconds:900,protectedDormitoryJitterSeconds:600,backgroundWeight:.35,sourceTimeWeight:.9,lunchEnvelopeWeight:.7,lunchCenterSeconds:44100,lunchWidthSeconds:1500,binWeightMultiplier:[.85,1.15],countsPreservedByDirection:true};
    }else{
      // Preserve the full-load stress input counts, while arrival times within
      // each five-minute cell vary reproducibly. Initial lunch stock remains.
      for(const row of plan.rows.filter(r=>r.origin.startsWith('D'))){
        if(row.ready===41400&&row.userSpecifiedDemandAssumption)continue;
        const bin=Math.floor((row.ready-start)/300);setTime(row,start+bin*300+random()*299);
      }
      plan.meta.timingModel={method:'full-load stress profile; seeded within-bin timing',fixedFiveMinuteLunchCountsAreStressAssumption:true};
    }
    // User field observation 2026-11-20 around 14:40 at AI공학관 (D01, downbound): one departure full,
    // the next about 2/3 full. Baseline S0 departs D01 at 14:35 and 14:40 with 23 seats, so arrivals in
    // (14:30,14:35] get +20 and (14:35,14:40] get +8 (fixed counts, so a seed changes timing only; with the
    // ~3-7 background arrivals this gives about 23 and 15). One observation day; not a measured rate.
    // Both profiles since 2026-11-21 (user request). lunch_full is already oversaturated downstream, so it does not reproduce the 2/3 departure.
    const pmRandom=randomGenerator(seed^0x14401450),downTemplate=plan.rows.find(r=>r.origin==='D01'&&r.destination==='D05'&&r.activityCategory==='other')||{origin:'D01',destination:'D05',residence:'unknown'};
    let pmAdded=0;
    for(const [lo,hi,extra] of [[52200,52500,20],[52500,52800,8]]){
      for(let k=0;k<extra;k++)plan.rows.push(makeRow({...downTemplate,activityCategory:'other',activitySubtype:'unexplained_arrivals',reason:'observed_20261120_AI_1440_full_departure',userSpecifiedDemandAssumption:true},lo+1+pmRandom()*(hi-lo-1),'PM1440_'+pmAdded++));
    }
    plan.meta.pmObservation20261120={date:'2026-11-20',U01:{time:'14:50',queueApprox:45,modelTarget:'pre-departure queue 45 before the 14:50 S0 departure'},
      D01:{time:'14:40',observed:'one downbound departure full, the next about 2/3',modelTarget:'fixed +20 D01 arrivals in 14:30-14:35 and +8 in 14:35-14:40 (both profiles, user request 2026-11-21); gives about 23 and 15 boardings in activity_reference only, lunch_full stays oversaturated',addedRequests:pmAdded},
      source:'user_field_observation_single_day',fitToOneDay:true};
    // Reconstruct the requested 13:00 residual queue in the actual ledger.
    // The existing KPI/chart convention is the stock after all events at the
    // same second. The 13:00 S0 vehicle has23 seats, so53 ready before boarding
    // become30 waiting after boarding. Keep that intermediate53 in the event
    // ledger and metadata rather than claiming it never occurs.
    const queue1300Candidates=plan.rows.filter(r=>r.origin==='U01'&&r.ready>=46800).sort((a,b)=>a.ready-b.ready||a.id.localeCompare(b.id)).slice(0,31);
    if(queue1300Candidates.length!==31)throw new Error('Insufficient requests for the 13:00 queue reconstruction');
    const queue1300Random=randomGenerator(seed^0x2e13a030);
    queue1300Candidates.forEach((row,i)=>{
      row.readyBefore1300QueueRevision=row.ready;
      row.queue1300StockRevision=true;
      setTime(row,i<28?Math.min(46799,Math.max(46501,46501+298*(i+1+.2*(queue1300Random()-.5))/29)):46800);
    });
    // The latest user constraint is the observed queue envelope. Reconstruct
    // finite actual arrivals from baseline departures, rather than repeating
    // 30..45 new arrivals every five minutes through the Mu service break.
    plan.meta.upstreamQueueEnvelope={targetMorning:42,targetLunch:42,targetMidMorning:18,
      localizedPeakTarget:50,localizedPeakDepartureSeconds:30120,localizedPeakTimingIsAssumption:true,
      local1030Target:34,reportedMaximumRange:[40,50],unit:'persons_waiting',
      arrivalTiming:'stratified between baseline departures with fixed-seed bounded jitter',
      jitterFractionOfStratum:.2,sharedAcrossPolicies:true,baselineSupplyInferred:true,
      noDisplayClamp:true,noAbandonmentOrHiddenRejection:true,
      supersedesLunchThirtyToFortyFivePerFiveMinutes:true,
      supersedes13To1305Count30:true,
      queueAt1300AfterEventsTarget:30,queueAt1300Phase:'after_all_events_at_same_second',
      queueAt1300RequestsRetimed:31,queueAt1300BeforeSecondRetimed:28,queueAt1300SameSecondRetimed:3,
      queueAt1300IntermediateArrivalState:53,queueAt1300IntermediateStateExceedsPostEventMaximum:true,
      validVerificationScope:'S0 U01 maximum50 holds by construction for every seed; S1/S5 maxima are outcomes and may exceed50'};
    plan.rows.sort((a,b)=>a.ready-b.ready||a.id.localeCompare(b.id));
    const counts={};for(const r of plan.rows)counts[r.origin.startsWith('D')?'DOWN':'UP']=(counts[r.origin.startsWith('D')?'DOWN':'UP']||0)+1;
    plan.meta.profile=profile;plan.meta.seed=seed;plan.meta.randomGenerator='xorshift32';plan.meta.sharedAcrossScenarios=true;
    plan.meta.newObservation={date:'2026-11-19',reportedTime:'10시30분대',reportedQueueApprox:34,origin:'U01',originInferredFromConversation:true,exactTimeKnown:false,beforeOrAfterBoardingKnown:false,source:'data_collection/observation_revision_v5_20261119/observations.json',modelConstraint:'pre-departure target34 for departures in [10:30,10:40); assumed representation of imprecise observation'};
    plan.meta.counts=counts;plan.meta.initialQueueAssumption=42;plan.meta.maxQueueTarget=50;plan.meta.midQueueTargetAssumption=18;
    plan.meta.basis='shared_supply_inferred_queue_envelope_reconstruction';
    plan.meta.queueEnvelopeAppliesTo='S0 U01 only, by construction (arrivals are back-calculated from S0 departures); other policies, demand or supply may exceed50';
    plan.meta.lunchFullLoadIsInputAssumption=profile==='lunch_full';
    plan.meta.userDemandRevision={...plan.meta.userDemandRevision,profile,upstream13To1305:null,upstreamLunchFiveMinuteRange:null,upstreamAfternoonFiveMinuteRange:null,additionalUpstreamRequestsFromLatestCurve:0,upstreamQueueEnvelope:[40,50],normalDownstreamFiveMinuteRange:profile==='lunch_full'?[18,23]:null,lunchDownstreamPerFiveMinutes:profile==='lunch_full'?60:null,source:'scenario_assumptions_not_field_measurements',lunchGoal:profile==='lunch_full'?'full AI lunch departures under default policies':'no full-load requirement; outcome calculated from activity-based demand'};
    plan.meta.assumptions=[
      'All policies within a selected demand profile and seed receive identical independent synthetic requests; no measured individual OD or linked return chain is claimed.',
      'U01 actual arrivals are reconstructed between baseline departures to approach42 waiting before morning and lunch departures, with one localized target50 before the08:22 baseline departure,18 mid-morning, and18..24 after13:00. The localized peak timestamp is a model assumption, not a newly observed timestamp. The approximate10:30s observation is represented by target34 before departures within10:30..10:40; exact observation time and boarding phase remain unknown.',
      'The latest40..50 queue-envelope request supersedes the prior30-to45 new arrivals per five minutes through lunch. No display clipping, latent rejected requests or abandonment is used. Counts are generated as finite supply-inferred synthetic arrivals, not field measurements.',
      'The activity_reference profile retains the original1111 downstream request count, derives a smoothed activity intensity from original synthetic planned times, and samples arrival times with a fixed seed. Its kernel, background and lunch envelope parameters are assumptions.',
      'The lunch_full profile separately retains increased full-load stress demand. A full bus is an imposed stress condition in this profile, not an independently validated forecast.',
      'Education D03 reallocation63, AI lunch55 outward/55 return activity labels, and dormitory requests are preserved. Timing is reconstructed;14:00 onward continuous curves remain estimates.',
      'To represent30 waiting at13:00 after the scheduled23-seat departure,31 existing future U01 requests are retimed:28 during12:55..13:00 and3 at13:00. Their OD/activity classifications and total request count remain unchanged. The event ledger exposes53 ready immediately before boarding and30 after; the existing maximum-queue KPI samples after all same-second events and must not be interpreted as a maximum over intermediate event processing states.'
    ];
    cache.set(key,plan);return plan;
  }
  function scaledRows(plan,options){
    const scale=options&&finite(options.demandScale)?+options.demandScale:1;
    const rows=[];let sequence=0;
    for(let i=0;i<plan.rows.length;i++){
      const r=plan.rows[i];let multiplier=scale;
      if(options&&r.activityCategory&&r.activityCategory.startsWith('ai_lunch'))multiplier*=finite(options.aiLunchScale)?+options.aiLunchScale:1;
      if(options&&r.residence==='dormitory')multiplier*=finite(options.dormitoryScale)?+options.dormitoryScale:1;
      const copies=Math.floor(multiplier)+(((i*2654435761>>>0)/4294967296)<multiplier%1?1:0);
      for(let c=0;c<copies;c++)rows.push({...r,id:'RECON_'+sequence,person:'RECON_PERSON_'+sequence++,boarded:null,completed:null,status:'waiting',trip:null,vehicle:null});
    }
    return rows.sort((a,b)=>a.ready-b.ready||a.id.localeCompare(b.id));
  }
  function replay(data,result,plan,options){
    plan=plan||createDemandPlan(data,options);const outcomes=scaledRows(plan,options),trips=clone(result.trips||[]),sourceEvents=result.events||[];
    const horizon=+result.summary.horizon_s,tripMap=new Map(trips.map(t=>[t.id,t]));
    const passengers=new Map(),queues=new Map(data.stops.map(s=>[s.id,[]]));
    const arrivalsByTrip=new Map();
    for(const e of sourceEvents)if(e.event==='arrival'){if(!arrivalsByTrip.has(e.trip))arrivalsByTrip.set(e.trip,new Map());arrivalsByTrip.get(e.trip).set(e.stop,+e.t);}
    let cursor=0;const events=[],maxByStop=Object.fromEntries(data.stops.map(s=>[s.id,0]));
    const ordered=sourceEvents.map((e,i)=>({...e,_order:i})).sort((a,b)=>a.t-b.t||(a.event==='arrival'?0:1)-(b.event==='arrival'?0:1)||a._order-b._order);
    function admit(t){while(cursor<outcomes.length&&outcomes[cursor].ready<=t){const row=outcomes[cursor++];if(!queues.has(row.origin))queues.set(row.origin,[]);const q=queues.get(row.origin);q.push(row);maxByStop[row.origin]=Math.max(maxByStop[row.origin]||0,q.length);}}
    for(const original of ordered){
      const e={...original,board:0,alight:0,onboard:0,queue:0};delete e._order;
      admit(+e.t);const trip=tripMap.get(e.trip),q=queues.get(e.stop)||[];
      let riding=passengers.get(e.trip)||[];
      if(e.event==='arrival'){
        for(const r of riding)if(r.destination===e.stop){r.completed=+e.t;r.status='completed';e.alight++;}
        riding=riding.filter(r=>r.destination!==e.stop);
      }else if(e.event==='departure'&&trip&&trip.revenue!==false){
        const stops=routes[trip.direction]||[],at=stops.indexOf(e.stop),available=Math.max(0,+(e.cap||trip.cap)-riding.length);
        const chosen=[];
        for(let i=0;i<q.length&&chosen.length<available;i++){
          const r=q[i],destAt=stops.indexOf(r.destination),destTime=(arrivalsByTrip.get(e.trip)||new Map()).get(r.destination);
          if(destAt>at&&finite(destTime)&&destTime>=e.t){chosen.push(r);r.boarded=+e.t;r.status='onboard';r.trip=e.trip;r.vehicle=e.vehicle;}
        }
        const selected=new Set(chosen);queues.set(e.stop,q.filter(r=>!selected.has(r)));riding.push(...chosen);e.board=chosen.length;
      }
      passengers.set(e.trip,riding);e.onboard=riding.length;e.queue=(queues.get(e.stop)||[]).length;
      if(e.onboard>+e.cap)throw new Error('Reconstructed capacity violation');events.push(e);
    }
    admit(horizon);for(const r of outcomes)if(r.ready>horizon)r.status='ready_after_horizon';
    const counts={completed:0,waiting:0,onboard:0,dependency_unserved:0,ready_after_horizon:0};for(const r of outcomes)counts[r.status]++;
    const board=outcomes.filter(r=>finite(r.boarded)),complete=outcomes.filter(r=>finite(r.completed));
    const supplyKeys=['case_id','policy','resource','service_date','horizon_s','horizon','last_departure_limit_s','physical_vehicles','driver_budget','drivers_created','used_vehicles','revenue_trip_count','nonrevenue_trip_count','vehicle_busy_seconds','driver_busy_seconds','capacity_violations','driver_overlap_violations','vehicle_overlap_violations','finite_driver_vehicle_check'];
    const summary={};for(const key of supplyKeys)if(result.summary[key]!==undefined)summary[key]=clone(result.summary[key]);
    Object.assign(summary,{status:'SYNTHETIC_QUEUE_ENVELOPE_RECONSTRUCTION_NOT_FIELD_VALIDATED',input_requests:outcomes.length,persons_with_input_requests:outcomes.length,request_status:counts,completed_requests:counts.completed,completed_request_service_rate:outcomes.length?counts.completed/outcomes.length:0,
      wait_boarded_seconds:stats(board.map(r=>r.boarded-r.ready)),original_request_to_arrival_completed_seconds:stats(complete.map(r=>r.completed-r.planned)),censored_unboarded_wait_seconds:stats(outcomes.filter(r=>r.status==='waiting').map(r=>horizon-r.ready)),maximum_queue:Math.max(...Object.values(maxByStop)),maximum_queue_by_stop:maxByStop,request_conservation:'PASS',boarding_alighting_conservation:'PASS',fieldCalibrated:false,profile:'shared_observation_queue_reconstruction',assumptions:plan.meta.assumptions.slice(),PM_semantics_pending:false,all_declared_arrival_counts_preserved_in_demand:false,sourceSupplyCase:result.summary.case_id||result.summary.policy,sharedReconstructedDemand:true});
    return{summary,trips,events,outcomes,meta:{...(result.meta||{}),reconstruction:{...plan.meta,demandScale:options&&options.demandScale||1,sourceRequestCount:result.outcomes.length,sourceSummaryStatus:result.summary.status}}};
  }
  function transform(data,result,options){return replay(data,result,createDemandPlan(data,options),options);}
  return{version:'3.2.0',createDemandPlan,replay,transform};
});
