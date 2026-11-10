/*
 * The horizontal run rail: stations, the rails between them, the arcs that carry parallel phases,
 * the fill frames left by hole insertion, the pill column under each station and the edge ledges
 * that stand in for the stations scrolled out of view.
 *
 * Geometry lives in `WF_TIMELINE` (41-detail-model.js); this part only draws and scrolls.
 */

/** Scroll step for one arrow key press, in pixels. */
const WF_TIMELINE_STEP = 192;

function wfTimelineStatusKey(status) {
  return `graph.status.${['running', 'done', 'failed', 'pending'].includes(status) ? status : 'pending'}`;
}

/**
 * One station head: lamp, name, the hole caret, the fraction and the round count.
 * @param {{ station: object, fraction: { settled: number, observed: number }, rounds?: number,
 *   t: Function, onOpen?: Function, openTestId?: string, script?: boolean }} props
 */
function WfTimelineStationHead(props) {
  const { station, fraction, rounds, t } = props;
  const lampClass = `zwf-lamp zwf-lamp-${station.status}${station.hole === 'waiting' ? ' zwf-lamp-hole-waiting' : ''}${station.hole === 'open' ? ' zwf-lamp-hole-open' : ''}`;
  const hole = station.hole === 'waiting'
    ? WF_H('span', { className: 'zwf-station-hole', 'data-testid': 'workflow-hole-waiting' }, WF_H('span', { className: 'zwf-station-hole-text' }, WF_UI.say(t, UI_EN, 'hole.waiting')))
    : null;
  return WF_H('div', { className: 'zwf-station-head', 'data-testid': 'workflow-timeline-station-head' },
    WF_H('span', { className: lampClass, 'aria-hidden': 'true' }),
    WF_H('span', { className: 'zwf-station-name', title: station.name }, station.name),
    hole,
    WF_H('span', { className: 'zwf-station-stats' },
      WF_H('span', {
        className: 'zwf-station-fraction zwf-mono',
        'data-testid': 'workflow-timeline-fraction',
      }, `${fraction.settled}/${fraction.observed}`),
      rounds !== undefined && rounds > 0
        ? WF_H('span', {
          className: 'zwf-station-rounds zwf-mono',
          'data-testid': 'workflow-timeline-rounds',
          title: WF_UI.say(t, UI_EN, 'timeline.rounds', { count: rounds }),
        }, String(rounds))
        : null),
    props.script === true
      ? WF_H('button', {
        type: 'button',
        className: 'zwf-station-script',
        'data-testid': 'workflow-timeline-workspace-open',
        title: WF_UI.say(t, UI_EN, 'timeline.openScript', { phase: station.name }),
        onClick: (event) => {
          event.stopPropagation();
          props.onOpenScript?.(station);
        },
      },
      WF_H(WF_UI.icons.log, { size: 12 }),
      WF_H('span', {}, WF_UI.say(t, UI_EN, 'graph.lane.script')))
      : null,
    WF_H('span', { className: 'zwf-station-caret', 'data-testid': 'workflow-timeline-caret', 'aria-hidden': 'true' }));
}

/**
 * The rail itself.
 *
 * @param {{
 *   stations: object[], roster: Map<string, object[]>, t: Function, focus?: number,
 *   scriptPhases?: Set<string>, onOpenEntry?: Function, onOpenStation?: Function, onOpenScript?: Function,
 *   fractions?: Map<string, { settled: number, observed: number }>, rounds?: Map<string, number>,
 *   ledger?: { earlier: number, later: number },
 * }} props
 */
function WfTimeline(props) {
  const { stations, roster, t } = props;
  const scroller = React.useRef(undefined);
  const [scroll, setScroll] = React.useState({ left: 0, width: 0 });
  const pitch = WF_TIMELINE.column + WF_TIMELINE.gap;
  const layout = React.useMemo(() => wfTimelineLayout(stations), [stations]);
  const focus = props.focus ?? wfFocusStation(stations);
  const focusLeft = Math.max(0, focus * pitch - 24);
  const fractionOf = (station) => (props.fractions?.get(station.name) ?? { settled: 0, observed: 0 });
  const roundsOf = (station) => props.rounds?.get(station.name);
  const measure = React.useCallback(() => {
    const node = scroller.current;
    if (node === undefined || node === null) return;
    setScroll({ left: node.scrollLeft, width: node.clientWidth });
  }, []);
  React.useEffect(() => {
    const node = scroller.current;
    if (node === undefined || node === null) return undefined;
    measure();
    node.addEventListener('scroll', measure, { passive: true });
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => {
        node.removeEventListener('scroll', measure);
        observer.disconnect();
      };
    }
    return () => node.removeEventListener('scroll', measure);
  }, [measure]);
  React.useEffect(() => {
    const node = scroller.current;
    if (node === undefined || node === null) return;
    if (Math.abs(node.scrollLeft - focusLeft) < 4) return;
    node.scrollTo({ left: focusLeft, behavior: 'smooth' });
  }, [focusLeft, layout.width]);
  const onKeyDown = React.useCallback((event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const target = event.target;
    const inside = target instanceof Element && target.closest('[data-testid="workflow-timeline-station"], .zwf-ledge') !== null;
    if (!inside) return;
    event.preventDefault();
    const node = scroller.current;
    if (node === undefined || node === null) return;
    node.scrollBy({ left: event.key === 'ArrowRight' ? WF_TIMELINE_STEP : -WF_TIMELINE_STEP, behavior: 'smooth' });
  }, []);
  if (stations.length === 0) return null;
  const maxScroll = Math.max(0, layout.width - scroll.width);
  const hiddenBefore = scroll.left > 8 ? stations.filter((station, index) => (index + 1) * pitch - 8 < scroll.left).length : 0;
  const hiddenAfter = scroll.left < maxScroll - 8
    ? stations.filter((station, index) => (index + 1) * pitch - 8 < scroll.left + scroll.width).length
    : 0;
  const fade = maxScroll <= 8 ? undefined : scroll.left <= 8 ? 'right' : scroll.left >= maxScroll - 8 ? 'left' : 'both';
  const fills = stations.filter((station) => station.hole === 'open');
  return WF_H('div', {
    className: 'zwf-timeline',
    'data-testid': 'workflow-timeline',
    onKeyDown,
  },
  WF_H('div', { className: 'zwf-timeline-frame' },
    WF_H('div', {
      className: 'zwf-timeline-scroller',
      'data-testid': 'workflow-timeline-scroller',
      'data-timeline-fade': fade,
      ref: scroller,
    },
    WF_H('div', { className: 'zwf-timeline-canvas', style: { width: layout.width, height: layout.height } },
      fills.length > 0
        ? WF_H(WF_FRAGMENT, null,
          WF_H('div', { className: 'zwf-fills', 'data-testid': 'workflow-timeline-fill-frames' },
            fills.map((station) => WF_H('span', {
              key: station.name,
              className: 'zwf-fill-frame',
              'data-testid': 'workflow-timeline-fill-frame',
              style: { left: station.index * pitch, width: WF_TIMELINE.column },
            }))),
          WF_H('div', { className: 'zwf-fill-heads', 'data-testid': 'workflow-timeline-fill-heads' },
            fills.map((station) => WF_H('span', {
              key: station.name,
              className: 'zwf-fill-head zwf-mono',
              'data-testid': 'workflow-timeline-fill-head',
              style: { left: station.index * pitch },
              title: station.name,
            }, station.name))))
        : null,
      WF_H('svg', {
        className: 'zwf-timeline-svg',
        width: layout.width,
        height: layout.height,
        'data-testid': 'workflow-timeline-arc',
        'aria-hidden': 'true',
      },
      WF_H('g', { 'data-rail-kind': 'stream' },
        layout.rails.map((rail) => WF_H('g', { key: rail.key },
          WF_H('path', {
            className: `zwf-rail zwf-rail-${rail.kind}`,
            'data-testid': 'workflow-timeline-rail',
            d: `M${rail.x1} ${rail.y}H${rail.x2}`,
          }),
          [0, 1, 2].map((offset) => WF_H('path', {
            key: offset,
            className: 'zwf-rail-chevron',
            d: `M${rail.x1 + 10 + offset * 6} ${rail.y - 3}l4 3-4 3`,
          }))))),
      layout.arcs.map((arc) => WF_H('path', {
        key: arc.key,
        className: 'zwf-arc',
        'data-air': arc.air,
        d: `M${arc.x1} 12V${12 - arc.air}H${arc.x2}V12`,
      }))),
      stations.map((station) => {
        const entries = roster.get(station.name) ?? [];
        const shown = entries.slice(0, WF_TIMELINE.maxPills);
        const rest = entries.length - shown.length;
        return WF_H('div', {
          key: station.name,
          className: 'zwf-station',
          'data-testid': 'workflow-timeline-station',
          'data-phase-status': station.status,
          style: { left: station.index * pitch, width: WF_TIMELINE.column },
        },
        WF_H('button', {
          type: 'button',
          className: 'zwf-station-button',
          onClick: () => props.onOpenStation?.(station),
          'aria-label': station.name,
        }, WF_H(WfTimelineStationHead, {
          station,
          fraction: fractionOf(station),
          rounds: roundsOf(station),
          t,
          script: props.scriptPhases?.has(station.name) === true,
          onOpenScript: props.onOpenScript,
        })),
        WF_H('div', {
          className: 'zwf-station-pills',
          'data-testid': 'workflow-timeline-pills',
          style: { top: WF_TIMELINE.pillsTop, width: WF_TIMELINE.column - 12, gap: WF_TIMELINE.pillGap },
        },
        shown.map((entry) => WF_H(WfAgentPill, {
          key: entry.key,
          entry,
          t,
          size: 'row',
          open: { testId: 'workflow-timeline-pill-open', onOpen: () => props.onOpenEntry?.(entry) },
        })),
        rest > 0
          ? WF_H(WfRosterDoor, {
            key: 'door',
            t,
            open: false,
            total: rest,
            entries: entries.slice(5),
            counts: props.counts?.get(station.name) ?? {},
            onToggle: () => props.onOpenStation?.(station),
          })
          : null));
      }),
      WF_H('span', { className: 'zwf-timeline-tail', 'data-testid': 'workflow-timeline-tail-stub', style: { left: layout.width - 12 } }))),
    hiddenBefore > 0
      ? WF_H('button', {
        type: 'button',
        className: 'zwf-ledge zwf-ledge-left',
        'data-testid': 'workflow-timeline-ledge-left',
        title: WF_UI.say(t, UI_EN, 'timeline.ledge.earlier', { count: hiddenBefore }),
        onClick: () => scroller.current?.scrollBy({ left: -WF_TIMELINE_STEP, behavior: 'smooth' }),
      },
      WF_H('span', { className: 'zwf-ledge-more', 'data-testid': 'workflow-timeline-ledge-more' }, `+${hiddenBefore}`),
      WF_H('span', { className: 'zwf-ledge-lamp', 'data-testid': 'workflow-timeline-ledge-lamp' }))
      : null,
    hiddenAfter > 0 && hiddenAfter < stations.length
      ? WF_H('button', {
        type: 'button',
        className: 'zwf-ledge zwf-ledge-right',
        'data-testid': 'workflow-timeline-ledge-right',
        title: WF_UI.say(t, UI_EN, 'timeline.ledge.later', { count: hiddenAfter }),
        onClick: () => scroller.current?.scrollBy({ left: WF_TIMELINE_STEP, behavior: 'smooth' }),
      },
      WF_H('span', { className: 'zwf-ledge-more', 'data-testid': 'workflow-timeline-ledge-more' }, `+${hiddenAfter}`),
      WF_H('span', { className: 'zwf-ledge-lamp', 'data-testid': 'workflow-timeline-ledge-lamp' }))
      : null,
    maxScroll > 8
      ? WF_H('div', { className: 'zwf-timeline-bar', 'data-testid': 'workflow-timeline-scrollbar', 'aria-label': WF_UI.say(t, UI_EN, 'timeline.scrollbar') },
        WF_H('span', {
          className: 'zwf-timeline-thumb',
          'data-testid': 'workflow-timeline-scrollbar-thumb',
          style: {
            width: `${Math.max(12, Math.round((scroll.width / Math.max(1, layout.width)) * 100))}%`,
            left: `${maxScroll === 0 ? 0 : Math.round((scroll.left / maxScroll) * (100 - Math.max(12, Math.round((scroll.width / Math.max(1, layout.width)) * 100))))}%`,
          },
        }))
      : null,
    WF_H('span', { className: 'zwf-timeline-leader', 'data-testid': 'workflow-timeline-leader', 'aria-hidden': 'true' })));
}
