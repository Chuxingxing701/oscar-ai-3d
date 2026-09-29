// Experiment history (left column): active + archived experiments from
// GET /api/v1/experiments. Selecting an archived experiment enters read-only
// replay (no POST can leave the page: the api layer throws before fetch).
// The select is persistent: live re-renders never reset the operator's pick.
import {h, fmtSimTime} from './ui.js';

const STATUS = {active: '进行中', archiving: '归档中', archived: '已归档'};

export function mountHistory(ctx) {
  const root = document.querySelector('#pane-resources');
  const select = h('select', {id: 'history-select', 'aria-label': '选择实验'});
  const enterButton = h('button', {type: 'button', id: 'history-enter'}, '打开所选实验');
  const refreshButton = h('button', {type: 'button'}, '刷新列表');
  const hint = h('p', {class: 'muted', style: {'font-size': '10px', margin: '6px 0 0'}}, '');
  const card = h('section', {class: 'card', id: 'history-card'},
    h('h2', {}, '实验历史'),
    h('div', {class: 'card-body'},
      h('label', {style: {width: '100%'}}, '实验（含归档）', select),
      h('div', {class: 'row', style: {marginTop: '6px'}}, enterButton, refreshButton),
      hint));
  root.prepend(card);

  const selectedExp = () => {
    const {experiments} = ctx.experimentsList();
    return (experiments || []).find(e => e.experiment_id === select.value) || null;
  };
  enterButton.addEventListener('click', () => {
    const exp = selectedExp();
    if (!exp) return;
    if (exp.status === 'archived') ctx.enterReplay(exp.experiment_id);
    else if (exp.experiment_id !== ctx.experimentsList().current_id) ctx.switchExperiment(exp.experiment_id);
    else ctx.setStatus('该实验即当前实验');
  });
  refreshButton.addEventListener('click', async () => {
    if (ctx.refreshExperiments) await ctx.refreshExperiments();
    render(ctx.getState());
  });

  function render(state) {
    const {current_id, experiments} = ctx.experimentsList();
    const replayId = ctx.isReplay() ? state.experimentId : null;
    const values = (experiments || []).map(e => e.experiment_id);
    if (select.dataset.values !== values.join('|')) {
      const previous = replayId || (!ctx.isReplay() ? current_id : null) || select.value;
      select.replaceChildren(...(experiments || []).map(exp =>
        h('option', {value: exp.experiment_id},
          `${exp.experiment_id} · ${STATUS[exp.status] || exp.status} · ${exp.scenario_id} · ${fmtSimTime(exp.sim_time_s)}`)));
      select.dataset.values = values.join('|');
      if (values.includes(previous)) select.value = previous;
    }
    enterButton.textContent = ctx.isReplay() ? '回放所选归档实验' : '打开所选实验';
    hint.textContent = ctx.isReplay()
      ? `只读回放 ${state.experimentId}：拖动时间线滑块查看历史状态；不会发出写请求。`
      : '归档实验只能只读回放；active 实验为当前实验。';
  }

  render(ctx.getState());
  return {render};
}
