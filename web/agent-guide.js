export function createAgentGuideUI({api,node,button,user,notify}) {
  let latest=null,base=null,editor=null,error=null,stale=null,current=null,preview=null,version=null,bootstrap=null,epoch=0;
  const root=()=>document.getElementById('agentGuide');
  function reset() {
    epoch++;root()?.replaceChildren();latest=base=editor=error=stale=current=preview=version=bootstrap=null;
  }
  function apply(guide) {
    const dirty=editor&&editor.value!==base.instructions;
    latest=guide;
    if(!current) {
      const target=root();target.replaceChildren();
      version=node('p','','muted');
      const currentBox=node('div',null,'guide-current');
      current=node('p');currentBox.append(node('strong','当前工作指示'),current);
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
      preview=node('pre',null,'guide-text');full.append(preview);
      target.append(version,currentBox,connection,full);
      if(user()?.role==='admin') {
        const form=node('form',null,'stack guide-editor');
        const label=node('label','目前工作指示');editor=node('textarea');editor.rows=4;editor.maxLength=12000;label.append(editor);
        const help=node('p','发布后，Agent 下次读取固定入口就会取得新指示。清空可恢复为仅使用内置指南。','muted');
        error=node('p','','error');error.setAttribute('role','alert');
        stale=node('div',null,'guide-conflict');stale.hidden=true;
        stale.append(node('p','已有更新。请对照上方当前指示与完整指南，保留需要的内容后再发布。'),button('保留草稿并使用最新版',()=>{base=latest;stale.hidden=true;error.textContent='已采用最新版本，草稿仍保留；可继续编辑并发布。';}));
        const save=node('button','发布工作指示','primary');save.type='submit';
        form.append(label,help,stale,save,error);
        form.addEventListener('submit',async event=>{
          event.preventDefault();save.disabled=true;editor.readOnly=true;error.textContent='';epoch++;
          const identity=user()?.id;
          try {
            const published=await api('/api/admin/agent-guide','POST',{version:base.version,instructions:editor.value});
            if(user()?.id!==identity||!form.isConnected) return;
            epoch++;base=published;editor.value=published.instructions;apply(published);
            notify('工作指示已发布，Agent 下次读取指南时生效');
          } catch(e) {if(form.isConnected) error.textContent=e.message;}
          finally {save.disabled=false;if(editor) editor.readOnly=false;}
        });
        target.append(form);
      }
      target.append(button('读取最新指南',refresh));
    }
    version.textContent=`版本 ${guide.version.slice(0,12)}${guide.updated_at?` · ${new Date(guide.updated_at).toLocaleString()}`:' · 内置指南'}`;
    current.textContent=guide.instructions||'目前未追加工作指示，Agent 按内置指南工作。';
    preview.textContent=guide.markdown;bootstrap.value=guide.bootstrap;
    if(editor) {
      if(!dirty) {base=guide;editor.value=guide.instructions;}
      stale.hidden=base.version===guide.version;
    }
  }
  async function refresh() {
    const ticket=++epoch,identity=user()?.id;
    try {
      const guide=await api('/api/agent-guide');
      if(ticket!==epoch||!identity||user()?.id!==identity) return;
      if(!guide.version) throw new Error('指南暂时无法载入，请稍后重试');
      apply(guide);
    } catch(e) {
      if(ticket!==epoch||!user()||user().id!==identity) return;
      if(error) error.textContent=e.message;
      else if(!current) {root().replaceChildren(node('p',e.message,'error'),button('重试读取指南',refresh));}
    }
  }
  return {refresh,reset};
}
