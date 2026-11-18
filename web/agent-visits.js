function visitTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false}).format(new Date(value));
}

export function createAgentVisitsUI({api, node, user}) {
  const entries = new Map();
  let generation = 0;

  function create(id) {
    const epoch = generation;
    const root = node('div', null, 'agent-visits');
    const presence = node('p', '', 'muted agent-presence');
    const details = node('details', null, 'agent-visit-history');
    details.dataset.agentId = String(id);
    const summary = node('summary', '到访时间记录');
    const body = node('div', null, 'agent-visit-body');
    const notice = node('p', '展开后读取近 30 天的到访时间。', 'muted');
    notice.setAttribute('role', 'status');
    const list = node('ol', null, 'agent-visit-list');
    const controls = node('div', null, 'action-row');
    const refresh = node('button', '刷新记录', 'text-button');refresh.type='button';
    const more = node('button', '查看更早记录', 'text-button');more.type='button';more.hidden=true;
    controls.append(refresh,more);body.append(notice,list,controls);details.append(summary,body);root.append(presence,details);
    let busy=false, loaded=false, failed=false, records=[], cursor=null, latest=null, snapshotLatest=null, total=null;

    function status() {
      if (!loaded || failed) return;
      notice.textContent = latest && (!snapshotLatest || latest > snapshotLatest)
        ? '有新的到访，点击“刷新记录”查看。'
        : records.length ? `已显示 ${records.length} 条到访时间${total==null ? '' : `（近 30 天共 ${total} 次访问请求）`}${cursor ? '，可继续查看更早记录。' : '。'}` : '近 30 天没有已记录的到访。';
    }
    function draw() {
      list.replaceChildren();
      for (const record of records) {
        const row=node('li'), time=node('time',visitTime(record.visited_at));time.dateTime=record.visited_at;
        row.append(time);list.append(row);
      }
      more.hidden=!cursor;
      status();
    }
    async function load(older=false) {
      if (busy || !root.isConnected || user()?.role!=='admin' || older&&!cursor) return;
      busy=true;failed=false;refresh.disabled=true;more.disabled=true;notice.classList.remove('error');notice.textContent='正在读取到访时间…';
      try {
        const result=await api(`/api/admin/agents/${id}/visits${older ? '?before='+encodeURIComponent(cursor) : ''}`);
        if (epoch!==generation || !root.isConnected) return;
        if(result.agent_id!==id || !Array.isArray(result.visits)) throw Error('到访记录响应不完整，请重试');
        const seen=new Set(older ? records.map(record=>record.id) : []);
        records=[...(older ? records : []), ...result.visits.filter(record=>!seen.has(record.id))]
          .filter(record=>record.visited_at>=result.cutoff_at);
        if(!older)total=Number.isSafeInteger(result.total_requests)?result.total_requests:null;
        cursor=result.next_cursor;loaded=true;snapshotLatest=records[0]?.visited_at||null;draw();
      } catch(error) {
        if(epoch!==generation || !root.isConnected) return;
        failed=true;
        notice.classList.add('error');notice.textContent=`到访时间读取失败：${error.message}。可点击“刷新记录”重试。`;
      } finally {
        busy=false;refresh.disabled=false;more.disabled=false;
      }
    }
    details.addEventListener('toggle',()=>{if(details.open&&!loaded)load();});
    refresh.addEventListener('click',()=>load());more.addEventListener('click',()=>load(true));
    return {root, update(person) {
      latest=person.last_seen_at||null;
      presence.textContent=!Object.hasOwn(person,'last_seen_at') ? '到访统计暂不可用'
        : latest ? `最近到访：${visitTime(latest)}` : '近 ' + 30 + ' 天无到访记录';
      const recent=records.filter(record=>Date.parse(record.visited_at)>=Date.now()-30*24*60*60*1000);
      if(recent.length!==records.length) {records=recent;draw();}
      if(!busy)status();
    }};
  }
  return {
    render(person) {
      if(!entries.has(person.id)) entries.set(person.id,create(person.id));
      const entry=entries.get(person.id);entry.update(person);return entry.root;
    },
    reset() {generation++;entries.clear();},
  };
}
