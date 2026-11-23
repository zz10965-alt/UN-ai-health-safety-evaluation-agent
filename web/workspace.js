/* Browser-only workspace. Imported responses are held in memory; only review decisions persist. */
(() => {
  const PILOT='04 Pilot Evaluation', SECOND='08 Review Evidence', HUMAN='Human Review';
  const RAW='Full Raw AI Response (paste unchanged)';
  const ratings=['Yes','Partially','No','N/A','Pending'];
  const codes=new Set(Array.from({length:20},(_,i)=>'C-'+String(i+1).padStart(2,'0')));
  let active=window.demoStudy;
  let previewCache;
  const require=(condition,message)=>{if(!condition)throw Error(message);};
  const storageKey=()=> 'evaluation-review-v1:'+active.version;
  function reviews(){
    try {return JSON.parse(localStorage.getItem(storageKey())||'[]');}
    catch {return [];}
  }
  function cellValue(cell){
    return cell.type===ExcelJS.ValueType.Formula ? cell.result ?? null : cell.text;
  }
  function sheetRows(book,name,header){
    const sheet=book.getWorksheet(name);
    require(sheet,'Missing worksheet: '+name);
    const rows=[];
    sheet.eachRow(row=>rows.push(Array.from({length:row.cellCount},(_,i)=>cellValue(row.getCell(i+1)))));
    const index=rows.findIndex(row=>row[0]===header);
    require(index>=0,'Missing column header in '+name);
    const headers=rows[index];
    return rows.slice(index+1).filter(row=>row[0]).map(row=>Object.fromEntries(
      headers.flatMap((key,i)=>key?[[key,row[i]??'']]:[])));
  }
  async function workbook(file){
    require(file&&file.name.toLowerCase().endsWith('.xlsx')&&file.size>0&&file.size<=8_000_000,
      'Select an .xlsx workbook of up to 8 MB for each input.');
    const bytes=await file.arrayBuffer(), view=new DataView(bytes);
    let footer=bytes.byteLength-22;
    while(footer>=Math.max(0,bytes.byteLength-65557)&&view.getUint32(footer,true)!==0x06054b50) footer--;
    require(footer>=Math.max(0,bytes.byteLength-65557),'Invalid .xlsx archive.');
    const count=view.getUint16(footer+10,true);
    let offset=view.getUint32(footer+16,true), expanded=0;
    for(let i=0;i<count;i++){
      require(offset+46<=footer&&view.getUint32(offset,true)===0x02014b50,'Invalid .xlsx archive directory.');
      expanded+=view.getUint32(offset+24,true);
      offset+=46+view.getUint16(offset+28,true)+view.getUint16(offset+30,true)+view.getUint16(offset+32,true);
    }
    require(count>0&&expanded<50_000_000,'Workbook expands beyond the supported size.');
    const data=new ExcelJS.Workbook();
    await data.xlsx.load(bytes);
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    return {data,hash};
  }
  function meta(r){
    return {response_id:r['Response ID'],prompt_id:r['Prompt ID'],model:r['AI Platform'],domain:r['Health Domain'],
      setting:r['Study Setting'],group:r.group,case:r.case,phase:r.phase};
  }
  function evaluationRows(log,source,byId){
    const pilot=source===PILOT;
    return sheetRows(log,source,pilot?'Evaluation ID':'Response ID').map(row=>{
      const r=byId.get(row['Response ID']), criterion_id=row[pilot?'Criterion':'Criterion ID'];
      require(r&&codes.has(criterion_id),'Invalid preliminary evaluation linkage in '+source);
      const source_rating=row[pilot?'Rubric Rating (AI preliminary)':'Current rating'];
      const rating=source_rating==='Pending verification'?'Pending':source_rating;
      require(ratings.includes(rating),'Unknown preliminary rating in '+source);
      const evidence=row[pilot?'Exact Response Evidence':'Exact response excerpt']||'';
      const source_critical_flag=row[pilot?'Critical Failure':'AI critical-failure flag']||'';
      return {...meta(r),criterion_id,source,rating,source_rating,evidence,
        quote_match:evidence?(r[RAW].includes(evidence)?'Exact match':'Unmatched'):'No excerpt',
        rationale:row[pilot?'Rationale Against Rubric':'Review rationale (中文)'],
        critical_candidate:/candidate|^potential/i.test(source_critical_flag),source_critical_flag,
        source_reference:row[pilot?'Medical Evidence Source':'Evidence reference'],
        source_fact_check:row['Local Fact Check'],source_provenance:row[pilot?'Human Review Status':'Review provenance'],
        evaluation_date:row['Evaluation Date'],record_status:'Preliminary'};
    });
  }
  async function importStudy(form){
    const files=['rubric','study'].map(k=>form.get(k));
    const [rubric,study]=await Promise.all(files.map(workbook));
    const log=study.data;
    const criteria=sheetRows(rubric.data,'Criteria (EN)','ID');
    require(criteria.length===20&&new Set(criteria.map(c=>c.ID)).size===20&&criteria.every(c=>codes.has(c.ID)&&
      ['Pass Condition (Yes)','Partial Condition','Fail Condition (No)','Fatal?','Notes'].every(k=>c[k])),
      'Expected all 20 official criteria and scoring anchors.');
    const prompts=sheetRows(log,'01 Pilot Prompts','Prompt ID');
    const byPrompt=new Map(prompts.map(p=>[p['Prompt ID'],p]));
    require(prompts.length===36&&byPrompt.size===36&&prompts.every(p=>p['Exact English Prompt']),'Expected 36 unique prompts.');
    for(const p of prompts){
      p.candidate_codes=[...new Set((p['Candidate Criteria']||'').match(/C-\d{2}/g)||[])].sort();
      require(p.candidate_codes.every(code=>codes.has(code)),'Unknown scenario criterion for '+p['Prompt ID']);
    }
    const responses=sheetRows(log,'02 Testing Log','Response ID');
    const byId=new Map(responses.map(r=>[r['Response ID'],r]));
    const models={ChatGPT:0,Gemini:0,Claude:0}, phases={Pilot:0,Expanded:0}, pairs=new Set();
    const prompt_mismatches=[], duplicateMap=new Map();
    require(responses.length===108&&byId.size===108,'Expected 108 unique response IDs.');
    for(const r of responses){
      const p=byPrompt.get(r['Prompt ID']), model=r['AI Platform'];
      const pair=r['Prompt ID']+'|'+model;
      require(p&&Object.hasOwn(models,model)&&typeof r[RAW]==='string'&&r[RAW].trim()&&!pairs.has(pair),
        'Invalid or duplicated prompt/model response linkage.');
      pairs.add(pair);
      models[model]++;
      r.phase=/transcript/i.test(r['Collection Method'])?'Expanded':'Pilot';
      phases[r.phase]++;
      r.group=p['Comparison Group'];
      r.case=p.Case;
      if(r['Exact Prompt Used']!==p['Exact English Prompt'])prompt_mismatches.push(r['Response ID']);
      const duplicateKey=model+'|'+r[RAW];
      if(!duplicateMap.has(duplicateKey))duplicateMap.set(duplicateKey,[]);
      duplicateMap.get(duplicateKey).push(r['Response ID']);
    }
    require(Object.values(models).every(n=>n===36),'Expected 36 responses for each evaluated model.');
    const evaluations=[...evaluationRows(log,PILOT,byId),...evaluationRows(log,SECOND,byId)];
    const checks=sheetRows(log,'06 Verification Log','Check ID');
    const reference=sheetRows(log,'10 Review Rubric','ID');
    const rubric_differences={};
    for(const c of criteria){
      const variants=reference.filter(r=>r.ID===c.ID);
      const fields=Object.keys(c).filter(k=>!variants.length||variants.some(r=>r[k]!==c[k]));
      if(fields.length||variants.length!==1)rubric_differences[c.ID]={workbook_rows:variants.length,differing_fields:fields};
    }
    const report={prompts:prompts.length,responses:responses.length,criteria:criteria.length,models,phases,
      prompt_mismatches,duplicate_text:[...duplicateMap.values()].filter(ids=>ids.length>1),rubric_differences,
      source_integrity_flags:checks.filter(r=>/duplicat/i.test(r['Check Focus'])),
      historical_counts:Object.fromEntries([PILOT,SECOND].map(s=>[s,evaluations.filter(e=>e.source===s).length])),
      hashes:[rubric.hash,study.hash],files:files.map(f=>f.name),imported_at:new Date().toISOString()};
    return {demo:false,version:report.hashes.join(':'),prompts,responses,criteria,checks,evaluations,report};
  }
  function saveReview(entry){
    const response=active.responses.find(r=>r['Response ID']===entry.response_id);
    const criterion=active.criteria.find(c=>c.ID===entry.criterion_id);
    const list=reviews();
    require(response&&criterion&&entry.actor.trim()&&entry.comment.trim()&&ratings.includes(entry.rating),
      'Select a response and criterion and enter a reviewer label and reason.');
    require(['Independent','Unresolved'].includes(entry.decision)&&
      ['Unverified','Pending','Verified','Not required'].includes(entry.verification)&&
      ['Unadjudicated','Dismissed','Confirmed'].includes(entry.critical),'Invalid review fields.');
    require(!(entry.decision==='Unresolved'||entry.verification==='Pending')||entry.rating==='Pending',
      'Unresolved reviews and decisive pending checks require a Pending rating.');
    require(!entry.exact_quote||response[RAW].includes(entry.exact_quote),'Quote must appear verbatim in the original response.');
    require(!ratings.slice(0,3).includes(entry.rating)||entry.exact_quote.trim(),'A scored rating requires a verbatim quote.');
    require(entry.critical!=='Confirmed'||(entry.rating==='No'&&criterion['Fatal?'].includes('CF-')),
      'Confirmation requires a No rating and a criterion with a critical trigger.');
    const previous=list.findLast(r=>r.response_id===entry.response_id&&r.criterion_id===entry.criterion_id);
    const record={...entry,id:crypto.randomUUID(),timestamp:new Date().toISOString(),previous_rating:previous?.rating};
    try {localStorage.setItem(storageKey(),JSON.stringify([...list,record]));}
    catch {throw Error('Browser storage is unavailable or full. Your decision was not saved.');}
    return record;
  }
  function results(source){
    const history=reviews(), byPair=new Map(history.map(r=>[r.response_id+':'+r.criterion_id,r]));
    const byId=new Map(active.responses.map(r=>[r['Response ID'],r]));
    const entries=source===HUMAN?[...byPair.values()].map(r=>({...meta(byId.get(r.response_id)),
      criterion_id:r.criterion_id,source,rating:r.rating,critical_candidate:false,record_status:'Reviewer decision'})):
      active.evaluations.filter(e=>e.source===source);
    return [entries.map(e=>{
      const r=byPair.get(e.response_id+':'+e.criterion_id);
      return {...e,review_rating:r?.rating,review_quote:r?.exact_quote,review_verification:r?.verification,
        review_critical:r?.critical,reviewer:r?.actor,review_status:r?.decision,review_timestamp:r?.timestamp,
        review_reason:r?.comment,dataset:active.demo?'Synthetic demonstration':'Imported study'};
    }),history];
  }
  function download(bytes,name,type){
    const url=URL.createObjectURL(new Blob([bytes],{type}));
    const link=document.createElement('a');
    link.href=url; link.download=name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function csvCell(value){
    const text=String(value??'');
    return '"'+(/^[\s]*[=+@-]/.test(text)?"'":'')+text.replaceAll('"','""')+'"';
  }
  async function exportFile(format,source){
    const [entries,history]=results(source);
    const filename='evaluation-'+(active.demo?'demo':'study');
    const columns=[...new Set(entries.flatMap(Object.keys))];
    if(format==='csv'){
      const rows=[columns,...entries.map(r=>columns.map(k=>r[k]))];
      download('\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'),filename+'.csv','text/csv;charset=utf-8');
      return;
    }
    const book=new ExcelJS.Workbook();
    const grouped=new Map();
    for(const e of entries){
      if(!grouped.has(e.response_id))grouped.set(e.response_id,{response_id:e.response_id,model:e.model,
        source:e.source,dataset:e.dataset,Yes:0,Partially:0,No:0,'N/A':0,Pending:0});
      grouped.get(e.response_id)[e.rating]++;
    }
    const summaries=[...grouped.values()].map(r=>{
      const scored=r.Yes+r.Partially+r.No, points=2*r.Yes+r.Partially;
      return {...r,applicable:scored+r.Pending,scored_points:points,scored_max:2*scored,
        scored_subset_pct:scored?Math.round(5000*points/scored)/100:null};
    });
    for(const [name,rows] of [['Criterion Results',entries],['Response Summary',summaries],['Review History',history]]){
      const sheet=book.addWorksheet(name,{views:[{state:'frozen',ySplit:1}]});
      const keys=[...new Set(rows.flatMap(Object.keys))];
      sheet.addRow(keys);
      for(const row of rows)sheet.addRow(keys.map(k=>row[k]??null));
      if(keys.length)sheet.autoFilter={from:{row:1,column:1},to:{row:1,column:keys.length}};
    }
    download(await book.xlsx.writeBuffer(),filename+'.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }
  window.workspace={
    async request(path,options){
      const [route,query]=path.split('?'), params=new URLSearchParams(query);
      if(route==='state')return {...active,reviews:reviews()};
      if(route==='results')return results(params.get('source')||SECOND);
      if(route==='review')return saveReview(JSON.parse(options.body));
      if(route==='import'){
        const preview=params.get('preview')==='true';
        const files=['rubric','study'].map(k=>options.body.get(k));
        const sameFiles=previewCache?.files.every((file,i)=>file===files[i]);
        const data=sameFiles?previewCache.data:await importStudy(options.body);
        if(preview)previewCache={files,data};else{active=data;previewCache=null;}
        return data.report;
      }
      throw Error('Unknown workspace operation.');
    },
    exportFile,
    loadDemo(){active=window.demoStudy;previewCache=null;}
  };
})();
