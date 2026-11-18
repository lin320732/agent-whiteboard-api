export function createAgentGuideUI({api,node,button,markdown,user,notify}) {
  let latest=null,base=null,editor=null,error=null,stale=null,current=null,preview=null,version=null,bootstrap=null,epoch=0;
  let scope=null,scopeSelect=null,scopeNote=null;
  const root=()=>document.getElementById('agentGuide');
  const isAdmin=()=>user()?.role==='admin';
  const textOf=guide=>scope?(guide.personal?.instructions||''):(guide.instructions||'');
  // Global scope keeps using the Agent entrypoint so old clients keep working;
  // only a per-Agent scope needs the admin preview endpoint.
  const pathFor=()=>scope?`/api/admin/agent-guide?agent_id=${scope}`:'/api/agent-guide';
  function reset() {
    epoch++;root()?.replaceChildren();latest=base=editor=error=stale=current=preview=version=bootstrap=null;scope=null;scopeSelect=null;scopeNote=null;
  }
  function renderCurrent(guide) {
    const blocks=[];
    if(guide.instructions) blocks.push(markdown(guide.instructions));
    if(guide.personal?.instructions) {
      if(blocks.length) blocks.push(node('p','以上为共用指示，以下是这位 Agent 的专属指示。','muted'));
      blocks.push(markdown(guide.personal.instructions));
    }
    if(!blocks.length) blocks.push(markdown('目前未追加工作指示，Agent 按内置指南工作。'));
    current.replaceChildren(...blocks);
  }
  function apply(guide) {
    const dirty=editor&&base&&editor.value!==textOf(base);
    latest=guide;
    if(!current) {
      const target=root();target.replaceChildren();
      version=node('p','','muted');
      const currentBox=node('div',null,'guide-current');
      current=node('div',null,'guide-instructions');currentBox.append(node('strong','当前工作指示'),current);
      const connection=node('details',null,'guide-connection');
      connection.append(node('summary','让 Agent 自己读取指南'));
      const label=node('label','只需设置一次的接入指令');
      bootstrap=node('textarea');bootstrap.readOnly=true;bootstrap.rows=3;label.append(bootstrap);
      connection.append(label,button('复制接入指令',async()=>{
        try {await navigator.clipboard.writeText(latest.bootstrap);notify('接入指令已复制');}
        catch {bootstrap.focus();bootstrap.select();notify('请复制已选中的接入指令');}
      }));
      connection.open=true;
      const full=node('details');full.append(node('summary','查看完整指南'));
      preview=node('div',null,'guide-text');full.append(preview);
      target.append(version,currentBox,connection,full);
      if(isAdmin()) {
        const form=node('form',null,'stack guide-editor');
        scopeSelect=node('select');
        const scopeLabel=node('label','套用到');
        scopeLabel.append(scopeSelect);
        scopeNote=node('p','本页只显示当前选择的范围内可编辑的工作指示；共用指示对所有 Agent 生效，专属指示只叠加给一位 Agent。','muted');
        scopeSelect.addEventListener('change',()=>{
          scope=scopeSelect.value?Number(scopeSelect.value):null;
          base=null;if(editor) editor.value='';refresh();
        });
        const label=node('label','目前工作指示');editor=node('textarea');editor.rows=4;editor.maxLength=12000;label.append(editor);
        const help=node('p','发布后，Agent 下次读取固定入口就会取得新指示。清空共用指示可恢复为仅使用内置指南；清空专属指示会删除该 Agent 的专属段落。','muted');
        error=node('p','','error');error.setAttribute('role','alert');
        stale=node('div',null,'guide-conflict');stale.hidden=true;
        stale.append(node('p','已有更新。请对照上方当前指示与完整指南，保留需要的内容后再发布。'),button('保留草稿并使用最新版',()=>{base=latest;stale.hidden=true;error.textContent='已采用最新版本，草稿仍保留；可继续编辑并发布。';}));
        const save=node('button','发布工作指示','primary');save.type='submit';
        form.append(scopeLabel,scopeNote,label,help,stale,save,error);
        form.addEventListener('submit',async event=>{
          event.preventDefault();save.disabled=true;editor.readOnly=true;error.textContent='';epoch++;
          const identity=user()?.id;
          try {
            const published=await api('/api/admin/agent-guide','POST',{version:base.version,instructions:editor.value,...(scope?{agent_id:scope}:{})});
            if(user()?.id!==identity||!form.isConnected) return;
            epoch++;base=published;editor.value=textOf(published);apply(published);
            notify(scope?'专属指示已发布，该 Agent 下次读取指南时生效':'工作指示已发布，Agent 下次读取指南时生效');
          } catch(e) {if(form.isConnected) error.textContent=e.message;}
          finally {save.disabled=false;if(editor) editor.readOnly=false;}
        });
        target.append(form);
        fillScopes();
      }
      target.append(button('读取最新指南',refresh));
    }
    version.textContent=`版本 ${guide.version.slice(0,12)}${guide.updated_at?` · ${new Date(guide.updated_at).toLocaleString()}`:' · 内置指南'}${scope?` · ${scopeName()}`:''}`;
    renderCurrent(guide);
    preview.replaceChildren(markdown(guide.markdown));bootstrap.value=guide.bootstrap;
    if(editor) {
      if(!dirty) {base=guide;editor.value=textOf(guide);}
      stale.hidden=base.version===guide.version;
    }
  }
  function scopeName() {
    if(!scope) return '全体 Agent';
    return scopeSelect?.selectedOptions?.[0]?.textContent||`Agent ${scope}`;
  }
  async function fillScopes() {
    try {
      const data=await api('/api/admin/agents');
      const agents=(data.accounts||data.agents||[]).filter(a=>a.kind!=='human');
      if(!agents.length) {scopeSelect.parentElement?.remove();scopeNote?.remove();return;}
      scopeSelect.append(node('option','全体 Agent（共用指示）'));
      scopeSelect.lastChild.value='';
      for(const agent of agents) {
        scopeSelect.append(node('option',agent.name||agent.username||`Agent ${agent.id}`));
        scopeSelect.lastChild.value=String(agent.id);
      }
      scopeSelect.value='';
    } catch {
      scopeSelect.parentElement?.remove();scopeNote?.remove();
    }
  }
  async function refresh() {
    const ticket=++epoch,identity=user()?.id;
    try {
      const guide=await api(isAdmin()?pathFor():'/api/agent-guide');
      if(ticket!==epoch||!identity||user()?.id!==identity) return;
      if(!guide.version) throw new Error('指南暂时无法载入，请稍后重试');
      if(scopeSelect&&String(scope||'')!==scopeSelect.value) scopeSelect.value=scope?String(scope):'';
      apply(guide);
    } catch(e) {
      if(ticket!==epoch||!user()||user().id!==identity) return;
      if(error) error.textContent=e.message;
      else if(!current) {root().replaceChildren(node('p',e.message,'error'),button('重试读取指南',refresh));}
    }
  }
  return {refresh,reset};
}
