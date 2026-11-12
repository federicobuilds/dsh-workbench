window.__ModuleLoader__.load({
  id: '@dsh-workbench/dsh-task-progress',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'task-progress';

    const en = {
      'aria.region': 'Station clock and task completion progress',
      'aria.progressbar': 'Earned value completion progress',
      'aria.popover': 'Toggle forecast accuracy and earned value metrics',
      'stoplight.green': 'On pace',
      'stoplight.amber': 'Slipping',
      'stoplight.red': 'At risk',
      'state.waiting': 'Waiting for you',
      'state.background': 'Background work',
      'state.complete': 'Done',
      'clock.expected': 'Expected {time}',
      'clock.remaining': '{time} remaining',
      'clock.elapsed': 'Elapsed {time}',
      'stats.tasks': '{done}/{total} tasks',
      'stats.scopeAdded': '+{added} scope',
      'pop.title': 'Forecast & Earned Value',
      'pop.ev': 'Earned value (EV / BAC)',
      'pop.evVal': '{ev} / {bac} steps',
      'pop.perf': 'Performance (SPI · CPI)',
      'pop.velocity': 'Calibrated pace',
      'pop.velocityVal': '{step}/step · {unit} steps/unit',
      'pop.verify': 'Verification since edit',
      'pop.verifyVal': '{count} calls (median {med})',
      'pop.mae': 'Forecast MAE vs naive',
      'pop.maeVal': '±{mae} (naive ±{naive}, n={n})',
      'pop.kilo': 'DSH guard blocks',
    };

    const zh = {
      'aria.region': '站台时钟与任务完成进度',
      'aria.progressbar': '挣值完成进度',
      'aria.popover': '查看预测误差与挣值指标',
      'stoplight.green': '正常',
      'stoplight.amber': '偏慢',
      'stoplight.red': '受阻',
      'state.waiting': '等待您的回复',
      'state.background': '后台运行中',
      'state.complete': '已完成',
      'clock.expected': '预计 {time} 完成',
      'clock.remaining': '剩余 {time}',
      'clock.elapsed': '已用时 {time}',
      'stats.tasks': '{done}/{total} 项任务',
      'stats.scopeAdded': '+{added} 新增',
      'pop.title': '预测校准与挣值 (EVM)',
      'pop.ev': '挣值进度 (EV / BAC)',
      'pop.evVal': '{ev} / {bac} 步',
      'pop.perf': '绩效指数 (SPI · CPI)',
      'pop.velocity': '校准速率',
      'pop.velocityVal': '{step}/步 · {unit} 步/单位',
      'pop.verify': '编辑后验证次数',
      'pop.verifyVal': '{count} 次 (中位 {med})',
      'pop.mae': '预测平均绝对误差 (MAE)',
      'pop.maeVal': '±{mae} (基线 ±{naive}, n={n})',
      'pop.kilo': 'DSH 守卫拦截',
    };

    const es = {
      'aria.region': 'Reloj de estación y progreso de tareas',
      'aria.progressbar': 'Progreso de valor ganado',
      'aria.popover': 'Alternar métricas de pronóstico y valor ganado',
      'stoplight.green': 'En ritmo',
      'stoplight.amber': 'Retraso leve',
      'stoplight.red': 'En riesgo',
      'state.waiting': 'Esperando tu respuesta',
      'state.background': 'Trabajo en segundo plano',
      'state.complete': 'Completado',
      'clock.expected': 'Fin est. {time}',
      'clock.remaining': '{time} restantes',
      'clock.elapsed': 'Transcurrido {time}',
      'stats.tasks': '{done}/{total} tareas',
      'stats.scopeAdded': '+{added} alcance',
      'pop.title': 'Pronóstico y Valor Ganado',
      'pop.ev': 'Valor ganado (EV / BAC)',
      'pop.evVal': '{ev} / {bac} pasos',
      'pop.perf': 'Índice (SPI · CPI)',
      'pop.velocity': 'Ritmo calibrado',
      'pop.velocityVal': '{step}/paso · {unit} pasos/unidad',
      'pop.verify': 'Verificaciones desde edición',
      'pop.verifyVal': '{count} llamadas (mediana {med})',
      'pop.mae': 'Error MAE vs base',
      'pop.maeVal': '±{mae} (base ±{naive}, n={n})',
      'pop.kilo': 'Bloqueos DSH',
    };

    const ja = { ...en };
    const fr = { ...en };
    const de = { ...en };
    const ru = { ...en };
    const pt = { ...en };

    const CSS = `
.tp-dock {
  box-sizing: border-box;
  width: calc(100% - var(--dsh-composer-side-clearance) * 2);
  max-width: var(--dsh-composer-card-max-width);
  margin: 0 auto 4px;
  font-family: inherit;
  color: var(--dsw-alias-label-primary);
  position: relative;
}
.tp-card {
  position: relative;
  isolation: isolate;
  box-sizing: border-box;
  width: 100%;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  padding: 6px 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.tp-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  background: transparent;
  border: none;
  padding: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.tp-header:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
  border-radius: 6px;
}
.tp-left {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex: 1;
}
.tp-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex: none;
  background: var(--dsw-alias-state-success-primary);
}
.tp-dot[data-light="amber"] {
  background: var(--dsw-alias-state-warn-primary);
}
.tp-dot[data-light="red"] {
  background: var(--dsw-alias-state-error-primary);
}
.tp-light-label {
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
}
.tp-pill {
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  flex: none;
  font-variant-numeric: tabular-nums;
}
.tp-pill[data-warn="true"] {
  color: var(--dsw-alias-state-warn-primary);
}
.tp-pill[data-error="true"] {
  color: var(--dsw-alias-state-error-primary);
}
.tp-reason {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.tp-right {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: none;
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.tp-percent {
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
}
.tp-sep {
  color: var(--dsw-alias-label-secondary);
  opacity: 0.55;
  font-size: 11px;
}
.tp-station-clock {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
}
.tp-station-sub {
  color: var(--dsw-alias-label-secondary);
  font-weight: 400;
}
.tp-delta {
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-state-warn-primary);
  white-space: nowrap;
}
.tp-delta[data-faster="true"] {
  color: var(--dsw-alias-state-success-primary);
}
.tp-track {
  position: relative;
  width: 100%;
  height: 5px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  overflow: hidden;
  display: flex;
}
.tp-fill-done {
  height: 100%;
  background: var(--dsw-alias-brand-primary);
  transition: width 0.3s cubic-bezier(0.22, 1, 0.36, 1);
  border-radius: 999px 0 0 999px;
}
.tp-fill-done[data-light="green"][data-complete="true"] {
  background: var(--dsw-alias-state-success-primary);
  border-radius: 999px;
}
.tp-fill-done[data-light="amber"] {
  background: var(--dsw-alias-state-warn-primary);
}
.tp-fill-done[data-light="red"] {
  background: var(--dsw-alias-state-error-primary);
}
.tp-fill-active {
  height: 100%;
  background: var(--dsw-alias-brand-primary);
  opacity: 0.42;
  transition: width 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
.tp-fill-active[data-light="amber"] {
  background: var(--dsw-alias-state-warn-primary);
}
.tp-fill-active[data-light="red"] {
  background: var(--dsw-alias-state-error-primary);
}
.tp-popover {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
  gap: 4px 14px;
  padding-top: 5px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.tp-pop-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.tp-pop-val {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
@media (max-width: 560px) {
  .tp-reason, .tp-station-expected {
    display: none;
  }
}
`;

    function formatCountdown(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '0s';
      const totalSeconds = Math.max(1, Math.round(ms / 1000));
      if (totalSeconds < 60) return `${totalSeconds}s`;
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      if (minutes < 60) {
        return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
      }
      const hours = Math.floor(minutes / 60);
      const remMinutes = minutes % 60;
      return `${hours}h ${String(remMinutes).padStart(2, '0')}m`;
    }

    function formatDelta(deltaMs) {
      const sign = deltaMs > 0 ? '+' : '−';
      const absSec = Math.round(Math.abs(deltaMs) / 1000);
      if (absSec < 60) return `${sign}${absSec}s`;
      const m = Math.floor(absSec / 60);
      const s = absSec % 60;
      return s > 0 ? `${sign}${m}m ${s}s` : `${sign}${m}m`;
    }

    function formatWallClock(epochMs) {
      if (!Number.isFinite(epochMs)) return '';
      try {
        return new Date(epochMs).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        });
      } catch {
        return '';
      }
    }

    function ClockIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', 'aria-hidden': true },
        h('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M8 4.8V8L10.2 9.4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' })
      );
    }

    function TaskGoalProgressDock({
      sessionId,
      useProjection,
      useSession,
      useSessions,
      useSessionStatus,
      t,
    }) {
      const rawTodos = useProjection('todos');
      const goalProj = useProjection('goal');
      // `taskProgress` wire.view already returns the complete Host-calibrated EVM/Analogy/Survival snapshot!
      const hostSnap = useProjection('taskProgress');
      const running = useSession(s => s.running) ?? false;
      const sessions = useSessions(s => s.byId);
      const statuses = useSessionStatus(s => s);
      const childRunning = Object.values(sessions).some(
        child => child.parentId === sessionId && (statuses.get(child.id)?.running ?? child.running)
      );
      const backgroundActive = Boolean(hostSnap?.backgroundJobsActive || childRunning);

      const [showPopover, setShowPopover] = React.useState(false);
      const [now, setNow] = React.useState(() => Date.now());
      const [revisionBadge, setRevisionBadge] = React.useState(null);

      // Anchor ref for strict 1s/s countdown between revision events
      const anchorRef = React.useRef({
        key: '',
        anchoredAt: 0,
        remainingAtAnchorMs: null,
        expectedFinishAt: null,
      });

      const todos = Array.isArray(rawTodos) ? rawTodos : [];
      const goal = goalProj?.goal ?? null;
      const hasTodos = todos.length > 0 || Boolean(hostSnap?.hasTodos);
      const hasVisibleGoal = (goal !== null && goal !== undefined && goal.phase !== 'complete') || Boolean(hostSnap?.hasVisibleGoal);

      // Lock a fresh countdown anchor whenever a discrete projection milestone or running state changes
      const triggerKey = `${sessionId}:${running}:${backgroundActive}:${todos.length}:${hostSnap?.completedCount ?? 0}:${hostSnap?.inProgressCount ?? 0}:${hostSnap?.totalSteps ?? 0}:${hostSnap?.lastRevisionAt ?? 0}:${goal?.id ?? ''}:${goal?.phase ?? ''}`;

      if (anchorRef.current.key !== triggerKey) {
        const nowMs = Date.now();
        const prevExpected = anchorRef.current.expectedFinishAt;
        const nextRemaining = hostSnap?.liveRemainingMs ?? hostSnap?.baselineRemainingMs ?? null;
        const nextExpected = nextRemaining !== null && nextRemaining > 0 ? nowMs + nextRemaining : null;

        if (
          anchorRef.current.key.startsWith(`${sessionId}:`)
          && prevExpected !== null
          && nextExpected !== null
          && Math.abs(nextExpected - prevExpected) >= 12000
        ) {
          const deltaMs = nextExpected - prevExpected;
          setRevisionBadge({
            deltaText: formatDelta(deltaMs),
            reason: hostSnap?.lastRevisionReason || (deltaMs > 0 ? 'pace adjusted' : 'ahead of pace'),
            faster: deltaMs < 0,
            until: nowMs + 8000,
          });
        }

        anchorRef.current = {
          key: triggerKey,
          anchoredAt: nowMs,
          remainingAtAnchorMs: nextRemaining,
          expectedFinishAt: nextExpected,
        };
      }

      const isWorkingOrBackground = running || backgroundActive;
      const shouldTick = isWorkingOrBackground && (hasTodos || hasVisibleGoal);

      React.useEffect(() => {
        setNow(Date.now());
        if (!shouldTick) return;
        const id = setInterval(() => {
          setNow(Date.now());
        }, 1000);
        return () => clearInterval(id);
      }, [shouldTick, triggerKey]);

      const hasStepActivity = isWorkingOrBackground && (hostSnap?.totalSteps ?? 0) > 0;
      if (!hasTodos && !hasVisibleGoal && !hasStepActivity) return null;

      const completedCount = hostSnap?.completedCount ?? todos.filter(i => i.status === 'completed').length;
      const totalCount = hostSnap?.totalCount ?? todos.length;
      const isAllDone = hasTodos && totalCount > 0 && completedCount === totalCount && !hasVisibleGoal;

      const stoplight = hostSnap?.stoplight ?? (goal?.phase === 'blocked' ? 'red' : 'green');
      const lightLabel = stoplight === 'red'
        ? t('stoplight.red')
        : stoplight === 'amber'
          ? t('stoplight.amber')
          : t('stoplight.green');

      // Strict 1-second-per-second countdown from the locked revision anchor while working/background.
      // When waiting for the user, the countdown freezes at `remainingAtAnchorMs` (no jump, no drain).
      const elapsedSinceAnchorMs = isWorkingOrBackground
        ? Math.max(0, now - anchorRef.current.anchoredAt)
        : 0;

      let displayRemainingMs = null;
      if (isAllDone) {
        displayRemainingMs = 0;
      } else if (anchorRef.current.remainingAtAnchorMs !== null) {
        const raw = anchorRef.current.remainingAtAnchorMs - elapsedSinceAnchorMs;
        if (raw >= 1000) {
          displayRemainingMs = raw;
        } else {
          // Overrun tail continuation: never stick at 1s forever
          const overrunMs = Math.max(2000, elapsedSinceAnchorMs - anchorRef.current.remainingAtAnchorMs);
          displayRemainingMs = Math.max(3000, Math.round((hostSnap?.calibratedStepMs ?? 11000) * 0.65 - (overrunMs % 6000)));
        }
      }

      // Expected finish timestamp holds steady while working, or shifts with user wait time
      const expectedFinishEpoch = displayRemainingMs !== null && displayRemainingMs > 0
        ? (isWorkingOrBackground && anchorRef.current.expectedFinishAt !== null && displayRemainingMs <= anchorRef.current.remainingAtAnchorMs
            ? anchorRef.current.expectedFinishAt
            : now + displayRemainingMs)
        : null;

      const donePercent = isAllDone
        ? 100
        : (hostSnap?.donePercent ?? (totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0));

      const stepExpectedMs = hostSnap?.activeStepExpectedMs ?? 11000;
      const liveStepFraction = isWorkingOrBackground && totalCount > 0
        ? Math.min(0.85, elapsedSinceAnchorMs / Math.max(3000, stepExpectedMs)) * (100 / Math.max(1, totalCount)) * 0.65
        : 0;
      const basePercent = hostSnap?.percent ?? donePercent;
      const percent = isAllDone
        ? 100
        : hasTodos
          ? Math.min(99, Math.max(donePercent, Math.round(basePercent + liveStepFraction)))
          : null;
      const activePercent = percent !== null ? Math.max(0, percent - donePercent) : 0;

      const waitingForUser = !isWorkingOrBackground && !isAllDone;
      const showDelta = revisionBadge && now < revisionBadge.until;

      const hoverSummary = hostSnap
        ? `EV ${hostSnap.evSteps}/${hostSnap.bacSteps} steps · SPI ${hostSnap.spi} · CPI ${hostSnap.cpi}` +
          (hostSnap.modelMaeMs !== null ? ` · MAE ±${formatCountdown(hostSnap.modelMaeMs)} (naive ±${formatCountdown(hostSnap.naiveMaeMs)})` : '')
        : '';

      return h('section', {
        className: 'tp-dock',
        'data-task-goal-progress': true,
        'aria-label': t('aria.region'),
      },
        h('div', { className: 'tp-card' },
          h('button', {
            type: 'button',
            className: 'tp-header',
            title: hoverSummary,
            'aria-expanded': showPopover,
            'aria-label': t('aria.popover'),
            onClick: () => setShowPopover(v => !v),
          },
            h('div', { className: 'tp-left' },
              h('span', { className: 'tp-dot', 'data-light': stoplight, 'aria-hidden': true }),
              h('span', { className: 'tp-light-label' }, lightLabel),
              hasTodos ? h('span', { className: 'tp-pill' },
                t('stats.tasks', { done: completedCount, total: totalCount })
              ) : null,
              !hasTodos && hasStepActivity ? h('span', { className: 'tp-pill' }, `Step ${hostSnap.totalSteps}`) : null,
              (hostSnap?.addedTasks ?? 0) > 0 ? h('span', {
                className: 'tp-pill',
                'data-warn': hostSnap.scopeGrowthRatio > 0.4 ? 'true' : undefined,
              }, t('stats.scopeAdded', { added: hostSnap.addedTasks })) : null,
              waitingForUser ? h('span', { className: 'tp-pill' }, t('state.waiting')) : null,
              backgroundActive && !running ? h('span', { className: 'tp-pill' }, t('state.background')) : null,
              stoplight !== 'green' && hostSnap?.stoplightReason ? h('span', {
                className: 'tp-reason',
                title: hostSnap.stoplightReason,
              }, hostSnap.stoplightReason) : null
            ),
            h('div', { className: 'tp-right' },
              showDelta ? h('span', {
                className: 'tp-delta',
                'data-faster': revisionBadge.faster ? 'true' : undefined,
                title: revisionBadge.reason,
              }, `${revisionBadge.deltaText} · ${revisionBadge.reason}`) : null,
              percent !== null ? h('span', { className: 'tp-percent' }, `${percent}%`) : null,
              percent !== null ? h('span', { className: 'tp-sep', 'aria-hidden': true }, '·') : null,
              h('span', { className: 'tp-station-clock' },
                h(ClockIcon),
                isAllDone
                  ? h('span', null, t('state.complete'))
                  : displayRemainingMs !== null
                    ? h(React.Fragment, null,
                        expectedFinishEpoch !== null && !waitingForUser ? h('span', { className: 'tp-station-expected' },
                          `${t('clock.expected', { time: formatWallClock(expectedFinishEpoch) })} · `
                        ) : null,
                        h('span', { className: waitingForUser ? 'tp-station-sub' : undefined },
                          t('clock.remaining', { time: formatCountdown(displayRemainingMs) })
                        )
                      )
                    : h('span', { className: 'tp-station-sub' },
                        t('clock.elapsed', { time: formatCountdown((hostSnap?.totalActiveMs ?? 0) + elapsedSinceAnchorMs) })
                      )
              )
            )
          ),
          hasTodos ? h('div', {
            className: 'tp-track',
            role: 'progressbar',
            'aria-label': t('aria.progressbar'),
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': percent ?? undefined,
          },
            h('div', {
              className: 'tp-fill-done',
              'data-light': stoplight,
              'data-complete': isAllDone ? 'true' : undefined,
              style: { width: `${isAllDone ? 100 : Math.max(donePercent, activePercent === 0 ? (percent ?? 0) : donePercent)}%` },
            }),
            !isAllDone && activePercent > 0 ? h('div', {
              className: 'tp-fill-active',
              'data-light': stoplight,
              style: { width: `${activePercent}%` },
            }) : null
          ) : null,
          showPopover && hostSnap ? h('div', {
            className: 'tp-popover',
            role: 'region',
            'aria-label': t('pop.title'),
          },
            hasTodos ? h('div', { className: 'tp-pop-row' },
              h('span', null, t('pop.ev')),
              h('span', { className: 'tp-pop-val' }, t('pop.evVal', { ev: hostSnap.evSteps, bac: hostSnap.bacSteps }))
            ) : null,
            hasTodos ? h('div', { className: 'tp-pop-row' },
              h('span', null, t('pop.perf')),
              h('span', { className: 'tp-pop-val' }, `SPI ${hostSnap.spi} · CPI ${hostSnap.cpi}`)
            ) : null,
            h('div', { className: 'tp-pop-row' },
              h('span', null, t('pop.velocity')),
              h('span', { className: 'tp-pop-val' }, t('pop.velocityVal', {
                step: formatCountdown(hostSnap.calibratedStepMs),
                unit: hostSnap.stepsPerUnit,
              }))
            ),
            h('div', { className: 'tp-pop-row' },
              h('span', null, t('pop.verify')),
              h('span', { className: 'tp-pop-val' }, t('pop.verifyVal', {
                count: hostSnap.verifyCallsSinceLastEdit,
                med: hostSnap.medianVerifyPerTask,
              }))
            ),
            hostSnap.modelMaeMs !== null ? h('div', { className: 'tp-pop-row' },
              h('span', null, t('pop.mae')),
              h('span', { className: 'tp-pop-val' }, t('pop.maeVal', {
                mae: formatCountdown(hostSnap.modelMaeMs),
                naive: formatCountdown(hostSnap.naiveMaeMs ?? hostSnap.modelMaeMs),
                n: hostSnap.forecastSampleCount,
              }))
            ) : null,
            hostSnap.guardActive ? h('div', { className: 'tp-pop-row' },
              h('span', null, t('pop.kilo')),
              h('span', { className: 'tp-pop-val' }, `${hostSnap.guardRecentBlocks} blocks · edit rev ${hostSnap.guardEditRevision ?? 0}`)
            ) : null
          ) : null
        )
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (typeof document !== 'undefined') {
          const tagId = '@dsh-workbench/dsh-task-progress/styles';
          let style = document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`);
          if (!style) {
            style = document.createElement('style');
            style.dataset.plugin = '@dsh-workbench/dsh-task-progress';
            style.dataset.pluginCss = tagId;
            style.textContent = CSS;
            document.head.appendChild(style);
          } else {
            style.textContent = CSS;
          }
          ctx.effect(() => () => {
            style?.remove();
          }, 'task-progress: styles');
        }

        ctx.effect(() => ctx.locale.register(NS, {
          zh,
          en,
          ja,
          es,
          fr,
          de,
          ru,
          pt,
        }), 'task-progress: dictionaries');

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'task-goal-progress',
          order: 5,
          locale: NS,
        }, TaskGoalProgressDock));
      },
    };
  },
});
