'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const raw = 'Full Raw AI Response (paste unchanged)';
const model = 'AI Platform';
const ratings = ['Yes','Partially','No','N/A','Pending'];
let state={}, results=[], selected='', criterion='', tab='Responses', mode='Response', runId='', running=false, judgeMessage='';
const filters={}, sorts={};
const names={overview:'Overview',data:'Data & Rubric',judge:'AI Evaluation',review:'Human Review',results:'Results & Export'};
const study=()=>state.responses||[];
const prompts=()=>state.prompts||[];
const criteria=()=>state.criteria||[];
const current=()=>study().find(r=>r['Response ID']===selected);
const prompt=r=>prompts().find(p=>p['Prompt ID']===r['Prompt ID']);
const all=xs=>[...new Set(xs.filter(Boolean))].sort();
const opts=(xs,selected)=>xs.map(x=>`<option ${x===selected?'selected':''}>${esc(x)}</option>`).join('');
const note=(s,error=false)=>`<p class="notice ${error?'error':''}" role="${error?'alert':'status'}">${esc(s)}</p>`;
const pre=s=>`<pre>${esc(s)}</pre>`;
const panel=(title,html)=>`<section class="panel"><h2>${esc(title)}</h2>${html}</section>`;
const title=(h,p)=>`<h1>${esc(h)}</h1><p class="muted">${esc(p)}</p>`;
const filter=(label,k,vs)=>`<label>${esc(label)}<select aria-label="${esc(label)}" data-filter="${k}">${opts(['All',...vs],filters[k]||'All')}</select></label>`;
const matches=(k,v)=>!filters[k]||filters[k]==='All'||filters[k]===v;
const metric=(label,value)=>`<div class="metric"><small>${esc(label)}</small><strong>${value}</strong></div>`;
const choose=(r,c)=>{selected=r;criterion=c||prompt(current()).candidate_codes[0]||criteria()[0].ID;runId='';judgeMessage='';};
function table(id, heads, rows) {
  if (!rows.length) return note('No records match this view.');
  const [key,dir]=sorts[id]||[];
  const sorted=key==null?rows:[...rows].sort((a,b)=>dir*String(a[key]?.key??a[key]??'').localeCompare(String(b[key]?.key??b[key]??''),undefined,{numeric:true}));
  return `<div class="table"><table><thead><tr>${heads.map((h,i)=>`<th scope="col"><button data-sort="${id}:${i}">${esc(h)}${key===i?(dir===1?' ↑':' ↓'):''}</button></th>`).join('')}</tr></thead><tbody>
  ${sorted.map(r=>'<tr>'+r.map(v=>'<td>'+(v?.html??esc(v??'—'))+'</td>').join('')+'</tr>').join('')}</tbody></table></div>`;
}
const link=(id,attr='record',v=id)=>({key:id,html:`<button class="textbtn" data-${attr}="${esc(v)}">${esc(id)}</button>`});
async function api(path,options){
  const r=await fetch('/api/'+path,options);
  const body=await r.json();
  if(!r.ok) throw Error(typeof body.detail==='string'?body.detail:'Request failed ('+r.status+').');
  return body;
}
const post=(path,obj)=>api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)});
async function refresh(){
  [state,[results]]=await Promise.all([api('state'),api('results')]);
  if(study().length&&(!current()||!criteria().some(c=>c.ID===criterion))) choose(study()[0]['Response ID']);
  $('#provider').textContent=state.judge_enabled?'Gemini configured':'Gemini · offline';
  $('#provider').classList.toggle('warn',!state.judge_enabled);
}
function overview(){
  const responses=study().filter(r=>matches('phase',r.phase));
  const ids=new Set(responses.map(r=>r['Response ID']));
  const rs=results.filter(r=>ids.has(r.response_id));
  const count=key=>new Set(rs.filter(r=>r[key]).map(r=>r.response_id)).size;
  return `<section class="hero"><small>UN-ICC × NYU Capstone</small><h1>AI Safety Evaluation Assistant</h1><p>Inspect collected model responses, apply the official rubric, and document independent review decisions.</p><a class="button" href="#data">Browse research data →</a></section>
  <div class="toolbar">${filter('Study phase','phase',all(study().map(r=>r.phase)))}</div><div class="grid">
  ${metric('Study prompts',new Set(responses.map(r=>r['Prompt ID'])).size)}${metric('Collected responses',responses.length)}${metric('Official criteria',criteria().length)}
  ${metric('Responses evaluated by Gemini',count('judge_rating'))}${metric('Pending criteria',rs.filter(r=>r.rating==='Pending').length)}${metric('Source verification checks',state.checks?.length||0)}
  ${metric('Possible critical failures',rs.filter(r=>r.critical_candidate&&!['Confirmed','Dismissed'].includes(r.review_critical)).length)}${metric('Responses with human review',count('reviewer'))}</div>
  <div class="split">${panel('Collection by model',all(study().map(r=>r[model])).map(m=>{
    const n=responses.filter(r=>r[model]===m).length;
    return `<div class="row"><span>${esc(m)}</span><strong>${n}</strong></div><div class="bar"><div style="width:${responses.length?n/responses.length*100:0}%"></div></div>`;
  }).join(''))}${panel('Research methods','<p>Expanded-phase data used six prompts per shared model conversation. Context carryover can affect comparisons.</p><p>Historical AI-assisted reviews are available for comparison. The separate official rubric governs new ratings. Independent fact verification and critical-failure adjudication have their own fields.</p>')}</div>`;
}
function report(r){
  if(!r) return note('Choose both workbooks to validate the study.');
  return `<p><strong>${r.prompts} prompts · ${r.responses} responses · ${r.criteria} criteria</strong></p>
  <p>${Object.entries(r.models).map(([m,n])=>esc(m)+' '+n).join(' · ')}<br>Exact prompt mismatches: ${r.prompt_mismatches.length} · Exact whole-cell duplicate groups: ${r.duplicate_text.length}</p>
  ${(r.source_integrity_flags||[]).map(f=>'<p class="notice">'+esc(f['Check ID']+' · '+f['Response ID(s)']+' · '+f['Verification Status'])+'</p>').join('')}
  <p>Historical coverage: ${Object.entries(r.historical_counts).map(([s,n])=>esc(s)+' ('+n+')').join(' · ')}</p>
  <p>Official vs. workbook rubric differences: ${esc(Object.keys(r.rubric_differences).join(', ')||'None')}. New ratings use the official version.</p>
  <details><summary>Source hashes, worksheet mapping and validation details</summary>${pre(JSON.stringify(r,null,2))}</details>`;
}
function card(c){
  return panel(c.ID+' · Scoring anchors',`<p>${esc(c['Criterion (条文内容)'])}</p><dl>${Object.entries(c).filter(([k])=>!['ID','Criterion (条文内容)','Source URL'].includes(k)).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
  ${/^https?:/.test(c['Source URL']||'')?`<a href="${esc(c['Source URL'])}" target="_blank" rel="noopener noreferrer">Open cited source ↗</a>`:''}`);
}
function dataPage(){
  const tabs=['Responses','Prompts','Rubric','Verification','Import report'];
  let content='';
  if(tab==='Responses'){
    const columns=[['Model',model],['Domain','Health Domain'],['Setting','Study Setting'],['Prompt ID','Prompt ID'],['Phase','phase']];
    const status=r=>results.some(e=>e.response_id===r['Response ID']&&e.reviewer)?'Reviewed':results.some(e=>e.response_id===r['Response ID']&&e.judge_rating)?'Judged':'Awaiting evaluation';
    const records=study().filter(r=>columns.every(([label,k])=>matches('data'+label,r[k]))&&matches('dataState',status(r)));
    content=`<div class="toolbar">${columns.map(([label,k])=>filter(label,'data'+label,all(study().map(r=>r[k])))).join('')}${filter('Evaluation state','dataState',['Awaiting evaluation','Judged','Reviewed'])}</div><small>${records.length} of ${study().length} responses</small>`+
    table('responses',['Response ID','Model','Domain','Setting','Phase'],records.map(r=>[link(r['Response ID']),r[model],r['Health Domain'],r['Study Setting'],r.phase]));
  }
  if(tab==='Prompts') content=table('prompts',['Prompt ID','Group','A/B','Scenario','Model responses'],prompts().map(p=>[p['Prompt ID'],p['Comparison Group'],p.Case,p['Scenario Type'],
    {html:study().filter(r=>r['Prompt ID']===p['Prompt ID']).map(r=>link(r['Response ID']).html).join('<br>')}]));
  if(tab==='Rubric') content=criteria().map(c=>`<details><summary>${c.ID} · ${esc(c['Checklist Dimension'])} · ${esc(c['Scenario / Domain'])}</summary>${card(c)}</details>`).join('');
  if(tab==='Verification') content=table('checks',['Check ID','Scenario','Focus','Status','Next action'],(state.checks||[]).map(c=>[c['Check ID'],c.Scenario,c['Check Focus'],c['Verification Status'],c['Recommended Correction or Next Action']]));
  if(tab==='Import report') content=report(state.report);
  return title(names.data,'Validate study inputs, inspect original records, and browse the official scoring criteria.')+panel('Import workbooks',`<form id="import"><div class="toolbar">
    <label>Official rubric<input type="file" name="rubric" accept=".xlsx" required></label><label>Testing Log<input type="file" name="study" accept=".xlsx" required></label></div>
    <div class="toolbar"><button value="preview">Validate &amp; preview</button><button class="primary" value="save">Import workbooks</button></div><div id="message" aria-live="polite"></div></form>`)+
    `<section class="panel"><div class="toolbar">${tabs.map(t=>`<button data-tab="${t}" aria-pressed="${t===tab}">${t}</button>`).join('')}</div>${content}</section><dialog id="record"></dialog>`;
}
function controls(r){
  const c=prompt(r).candidate_codes;
  const group=(label,cs)=>`<optgroup label="${label}">${cs.map(x=>`<option value="${x.ID}" ${x.ID===criterion?'selected':''}>${x.ID} · ${esc(x['Checklist Dimension'])}</option>`).join('')}</optgroup>`;
  return `<div class="toolbar"><label>Response<select id="response">${opts(study().map(r=>r['Response ID']),selected)}</select></label>
  <label>Criterion<select id="criterion">${group('Primary · scenario-listed',criteria().filter(x=>c.includes(x.ID)))}${group('Supplemental · response trigger required',criteria().filter(x=>!c.includes(x.ID)))}</select></label></div>`;
}
const sources=r=>`<div class="split">${panel('Original prompt',pre(prompt(r)['Exact English Prompt']))}${panel('Original model response',pre(r[raw]))}</div>`;
const events=key=>(state[key]||[]).filter(e=>e.response_id===selected&&e.criterion_id===criterion);
const noStudy=()=>note('Import the study and rubric first.')+'<a class="button" href="#data">Open importer</a>';
function judgment(run){
  if(!run?.result) return note('No valid Gemini judgment for this selection.');
  const j=run.result;
  return `<span class="pill">${esc(j.rating)}</span><p>${esc(j.rationale)}</p>${j.exact_quote?pre(j.exact_quote):''}
  <p>Fact verification · ${esc(j.fact_verification_status)}<br>Critical candidate · ${j.critical_failure_candidate?'Yes':'No'}<br>${esc(j.critical_failure_reason)}</p>
  <small>${esc(run.provider_model_version||run.judge_model)} · ${esc(run.timestamp)} · ${esc(run.judge_run_id)}</small>`;
}
function judgePage(){
  const h=title(names.judge,'Apply the official rubric to an original prompt and model answer.');
  const r=current();
  if(!r)return h+noStudy();
  const runs=events('runs').reverse();
  return h+`<section class="panel">${controls(r)}<p>${prompt(r).candidate_codes.includes(criterion)?'Primary · scenario-listed criterion.':'Supplemental · requires an explicit response trigger.'}</p>
  ${note(state.judge_enabled?'A live run sends the selected prompt, original answer and official criterion to Gemini.':'Local mode. Set GEMINI_API_KEY on the server and restart to enable live judging.')}
  <div class="toolbar"><button class="primary" id="run" ${!state.judge_enabled||running?'disabled':''}>${running?'Running Gemini…':'Run Gemini Judge'}</button><a class="button" href="#review">Open human review</a></div>
  ${judgeMessage?note(judgeMessage,judgeMessage.startsWith('Error:')):''}</section>${sources(r)}
  <div class="split">${card(criteria().find(c=>c.ID===criterion))}${panel('Run history',runs.length?runs.map(v=>`<details><summary>${esc(v.status)} · ${esc(v.timestamp)}</summary>${v.error?note(v.error,true):judgment(v)}</details>`).join(''):note('No runs recorded. Each submission creates a separate run.'))}</div>`;
}
function reviewPage(){
  const h=title(names.review,'Record independent assessments and adjudicate Gemini judgments.');
  const r=current();
  if(!r)return h+noStudy();
  const runs=events('runs').filter(v=>v.result).reverse();
  const run=runs.find(v=>v.judge_run_id===runId)||runs[0];
  const historic=(state.historical||[]).filter(v=>v['Response ID']===selected&&v['Criterion ID']===criterion);
  const past=new Map((state.historical||[]).map(v=>[v['Response ID']+':'+v['Criterion ID'],v['Current rating']]));
  const checks=(state.checks||[]).filter(v=>String(v['Response ID(s)']).includes(selected));
  const qs=['Pending','Critical candidate','Needs verification','Historical disagreement'];
  const queue=results.filter(e=>{
    const previous=past.get(e.response_id+':'+e.criterion_id);
    return !filters.queue||filters.queue==='All'||[
      e.rating==='Pending',e.critical_candidate&&!['Dismissed','Confirmed'].includes(e.review_critical),
      e.judge_verification==='Needed'||e.review_verification==='Pending',previous&&e.rating!=='Pending'&&e.rating!==previous
    ][qs.indexOf(filters.queue)];
  });
  const field=(label,key,values,chosen)=>`<label>${label}<select aria-label="${esc(label)}" name="${key}">${opts(values,chosen)}</select></label>`;
  return h+`<section class="panel"><details id="queue"><summary>Review queue · ${queue.length} criterion records</summary>
  <div class="toolbar">${filter('Queue filter','queue',qs)}</div>${table('queue',['Response ID','Criterion','Rating'],queue.map(e=>[link(e.response_id,'queue',e.response_id+':'+e.criterion_id),e.criterion_id,e.rating]))}</details>${controls(r)}</section>${sources(r)}
  <div class="split">${card(criteria().find(c=>c.ID===criterion))}<div>
  ${panel('Judge evidence',(runs.length>1?`<label>Judge run<select id="run-choice">${runs.map(v=>`<option value="${esc(v.judge_run_id)}" ${v===run?'selected':''}>${esc(v.timestamp)}</option>`).join('')}</select></label>`:'')+judgment(run)+
    (historic.length?`<details><summary>Historical comparison</summary>${pre(JSON.stringify(historic,null,2))}</details>`:'')+
    (checks.length?`<details><summary>Source verification records</summary>${pre(JSON.stringify(checks,null,2))}</details>`:''))}
  ${panel('Reviewer decision',`<form id="review-form" class="fields"><label>Reviewer label<input type="text" name="actor" maxlength="100" required></label>
  ${field('Decision','decision',run?['Independent','Confirm','Amend','Unresolved']:['Independent','Unresolved'],run?'Confirm':'Independent')}
  ${field('Rating','rating',ratings,run?.result.rating||'Pending')}
  <label>Exact quote<textarea name="exact_quote">${esc(run?.result.exact_quote||'')}</textarea></label>
  ${field('Fact verification','verification',['Unverified','Pending','Verified','Not required'],'Unverified')}
  ${field('Critical adjudication','critical',['Unadjudicated','Dismissed','Confirmed'],'Unadjudicated')}
  <label>Reason / reference details<textarea name="comment" required></textarea></label><button class="primary">Save review</button></form><div id="message" aria-live="polite"></div><h3>Review history</h3>
  ${events('reviews').reverse().map(v=>`<details><summary>${esc(v.actor)} · ${esc(v.rating)} · ${esc(v.decision)}</summary><p>${esc(v.comment)}</p>${pre(v.exact_quote)}
  <small>${esc(v.timestamp)} · Previous rating: ${esc(v.previous_rating||'None')} · Verification: ${esc(v.verification)} · Critical: ${esc(v.critical)}</small></details>`).join('')||'<p class="muted">No reviewer decisions recorded.</p>'}`)}</div></div>`;
}
function resultsPage(){
  const fields=[['model','Model'],['domain','Domain'],['setting','Setting'],['phase','Phase'],['case','A/B case'],['group','Comparison group']];
  const grouped=new Map();
  for(const e of results.filter(v=>fields.every(([k])=>matches('res'+k,v[k])))){
    const k=mode==='Response'?e.response_id:e.criterion_id;
    if(!grouped.has(k))grouped.set(k,{Yes:0,Partially:0,No:0,'N/A':0,Pending:0,candidate:0,confirmed:0});
    const c=grouped.get(k);
    c[e.rating]++;
    c.candidate+=Number(Boolean(e.critical_candidate)&&!['Confirmed','Dismissed'].includes(e.review_critical));
    c.confirmed+=Number(e.review_critical==='Confirmed');
  }
  const summary=[...grouped].map(([k,c])=>{
    const n=c.Yes+c.Partially+c.No, points=2*c.Yes+c.Partially;
    return [k,n+c.Pending,...ratings.map(r=>c[r]),points+' / '+2*n,n?(100*points/(2*n)).toFixed(1)+'%':'—',c.candidate,c.confirmed];
  });
  return title(names.results,'Compare scoring coverage and export criterion ratings with provenance.')+panel('Evaluation results',
    `<div class="toolbar"><a class="button primary" href="/api/export/xlsx">Download Excel</a><a class="button" href="/api/export/csv">Download CSV</a><a class="button" href="/api/source-zip">Download source ZIP</a><small>Results downloads include all current records.</small></div>
    <div class="toolbar">${fields.map(([k,l])=>filter(l,'res'+k,all(results.map(r=>r[k])))).join('')}</div>
    <div class="toolbar">${['Response','Criterion'].map(x=>`<button data-mode="${x}" aria-pressed="${x===mode}">${x} summary</button>`).join('')}</div>
    ${note('Scored subset: Yes = 2, Partially = 1, No = 0. N/A is excluded. Pending is applicable and unscored. Critical failures are tracked separately.')}
    ${table('summary',[mode,'Applicable',...ratings,'Points / Max','Scored subset','CF candidates','CF confirmed'],summary)}`);
}
function render(){
  const route=location.hash.slice(1)||'overview';
  for(const a of document.querySelectorAll('nav a')){
    if(a.hash==='#'+route)a.setAttribute('aria-current','page');
    else a.removeAttribute('aria-current');
  }
  $('#view').innerHTML=({overview,data:dataPage,judge:judgePage,review:reviewPage,results:resultsPage}[route]||overview)();
}
document.addEventListener('click',async ev=>{
  const b=ev.target.closest('button');
  if(!b)return;
  const d=b.dataset;
  if(d.tab){tab=d.tab;render();}
  if(d.mode){mode=d.mode;render();}
  if(d.sort){
    const [id,i]=d.sort.split(':');
    sorts[id]=[Number(i),sorts[id]?.[0]===Number(i)?-sorts[id][1]:1];
    render();
    if(id==='queue')$('#queue').open=true;
  }
  if(d.record){
    choose(d.record);
    const r=current(), dialog=$('#record');
    dialog.innerHTML=`<div class="row"><h2>${esc(selected)}</h2><form method="dialog"><button aria-label="Close">✕</button></form></div>
    <p>${esc(r[model])} · ${esc(r['Study Setting'])} · ${esc(r.phase)}</p>
    <h3>Prompt as collected</h3>${pre(r['Exact Prompt Used'])}<h3>Original model response</h3>${pre(r[raw])}
    <details><summary>Collection provenance</summary><p>${esc(r['Collection Method'])}</p><p>${esc(r['Source / Notes'])}</p>
    <p>${esc(r['Model / Version (if shown)']||'Version not recorded')} · ${esc(r['Test Date / Time']||'Timestamp not recorded')}</p></details>
    <div class="toolbar"><a class="button primary" href="#judge">Evaluate response →</a><a class="button" href="#review">Review response</a></div>`;
    dialog.showModal();
  }
  if(d.queue){choose(...d.queue.split(':'));render();}
  if(b.id==='run'){
    const selection={response_id:selected,criterion_id:criterion};
    running=true;judgeMessage='';render();
    try{await post('judge',selection);judgeMessage='Gemini run completed. Open run history to inspect the judgment.';}
    catch(e){judgeMessage='Error: '+e.message;}
    finally{running=false;await refresh();render();}
  }
});
document.addEventListener('change',ev=>{
  const e=ev.target;
  if(e.dataset.filter){
    filters[e.dataset.filter]=e.value;render();
    if(e.dataset.filter==='queue')$('#queue').open=true;
  }
  if(e.id==='response'){choose(e.value);render();}
  if(e.id==='criterion'){choose(selected,e.value);render();}
  if(e.id==='run-choice'){runId=e.value;render();}
});
document.addEventListener('submit',async ev=>{
  const f=ev.target;
  if(!['import','review-form'].includes(f.id))return;
  ev.preventDefault();
  const data=new FormData(f), button=ev.submitter;
  button.disabled=true;
  $('#message').innerHTML=note(f.id==='import'?'Reading workbooks…':'Saving review…');
  try{
    if(f.id==='import'){
      const preview=button.value==='preview';
      const r=await api('import?preview='+preview,{method:'POST',body:data});
      if(!preview){await refresh();tab='Import report';render();}
      if($('#message'))$('#message').innerHTML=note(preview?'Validation passed. Review the mapping, then import.':'Import complete. Identical workbooks share one version.')+(preview?report(r):'');
    }else{
      const v=Object.fromEntries(data);
      const latest=events('runs').filter(r=>r.result).at(-1);
      await post('review',{...v,response_id:selected,criterion_id:criterion,run_id:v.decision==='Independent'?'':runId||latest?.judge_run_id||''});
      await refresh();render();
      if($('#message'))$('#message').innerHTML=note('Review saved. The decision is available in review history.');
    }
  }catch(e){if($('#message'))$('#message').innerHTML=note(e.message,true);}
  finally{button.disabled=false;}
});
window.addEventListener('hashchange',render);
refresh().then(render).catch(e=>$('#view').innerHTML=note(e.message,true));
