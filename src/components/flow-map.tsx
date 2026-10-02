import { NODES, NODE_HELP, NODE_LABEL, type FlowNode } from "@/domain/ops";
import { cx } from "./ui";

/*
 * The operational flow OWNER -> CONTRACT -> BUILDER -> EVIDENCE -> GATE -> VERIFIER -> DECISION as a live instrument. Every visual
 * state is driven by authoritative data passed in by the caller:
 *   count      - tasks currently at the node (control-loop step)
 *   active     - a worker session / gate run is actually running for it
 *   alert      - owner decisions open (the trust-boundary interruption)
 *   pulses     - edges a real state transition travelled in the last 90 s
 *   correction - a task is on the correction path (gate -> builder) / repair path (gate -> verifier)
 * No node moves, spins or glows unless one of these is true. Motion respects prefers-reduced-motion (globals.css).
 */
export interface FlowState {
  counts: Record<FlowNode, number>;
  active: Partial<Record<FlowNode, boolean>>;
  alert: number;
  pulses: [FlowNode, FlowNode][];
  correcting: boolean;
  repairing: boolean;
  resolved: number;
}

const TONE: Record<FlowNode, string> = {
  owner: "var(--color-owner)",
  contract: "var(--color-accent)",
  builder: "var(--color-builder)",
  evidence: "var(--color-ink-2)",
  gate: "var(--color-gate)",
  verifier: "var(--color-verifier)",
  decision: "var(--color-ok)",
};

const H_POS: Record<FlowNode, [number, number]> = {
  owner: [70, 120],
  contract: [205, 120],
  builder: [340, 120],
  evidence: [475, 120],
  gate: [625, 120],
  verifier: [775, 120],
  decision: [915, 120],
};
const V_POS: Record<FlowNode, [number, number]> = {
  owner: [70, 50],
  contract: [70, 140],
  builder: [70, 230],
  evidence: [70, 320],
  gate: [70, 420],
  verifier: [70, 520],
  decision: [70, 610],
};

function isPulse(pulses: [FlowNode, FlowNode][], a: FlowNode, b: FlowNode) {
  return pulses.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

function Node({ n, pos, s, big, hideLabel }: { n: FlowNode; pos: [number, number]; s: FlowState; big?: boolean; hideLabel?: boolean }) {
  const [x, y] = pos;
  const r = big ? 36 : 26;
  const count = s.counts[n];
  const active = !!s.active[n];
  const alert = n === "owner" && s.alert > 0;
  const tone = TONE[n];
  const lit = count > 0 || active || alert;
  return (
    <g className={cx("flow-node", active && "is-active", alert && "is-alert")} style={{ color: tone }}>
      <title>{`${NODE_LABEL[n]}: ${NODE_HELP[n]} - ${count} task(s) here${active ? ", working now" : ""}${alert ? `, ${s.alert} decision(s) waiting for you` : ""}`}</title>
      {big ? (
        // targeting / gyroscope rings of the enforcement node - they turn only while a gate evaluation is actually running
        <g className={cx("hud-rings", active && "is-spinning")} style={{ transformOrigin: `${x}px ${y}px` }}>
          <circle cx={x} cy={y} r={r + 16} fill="none" stroke="currentColor" strokeOpacity={lit ? 0.35 : 0.12} strokeDasharray="2 7" />
          <circle cx={x} cy={y} r={r + 9} fill="none" stroke="currentColor" strokeOpacity={lit ? 0.5 : 0.15} strokeDasharray="30 12 4 12" />
        </g>
      ) : null}
      {active || alert ? <circle className="flow-halo" cx={x} cy={y} r={r + 6} fill="none" stroke="currentColor" strokeWidth={2} /> : null}
      <circle cx={x} cy={y} r={r} fill="var(--color-panel)" stroke="currentColor" strokeOpacity={lit ? 0.95 : 0.3} strokeWidth={lit ? 2 : 1.25} />
      <circle cx={x} cy={y} r={r - 7} fill="currentColor" fillOpacity={lit ? 0.14 : 0.04} />
      <text x={x} y={y + 5} textAnchor="middle" fontSize={big ? 20 : 16} fontWeight={700} fill={lit ? "currentColor" : "var(--color-mute)"}>
        {count || "·"}
      </text>
      {hideLabel ? null : (
        <text x={x} y={y + r + 22} textAnchor="middle" fontSize={12} letterSpacing={1.5} fill={lit ? "var(--color-ink)" : "var(--color-mute)"} style={{ textTransform: "uppercase" }}>
          {NODE_LABEL[n]}
        </text>
      )}
    </g>
  );
}

export function FlowMap({ s, label }: { s: FlowState; label: string }) {
  const summary = NODES.map((n) => `${NODE_LABEL[n]} ${s.counts[n]}${s.active[n] ? " (working)" : ""}`).join(", ");
  return (
    <div className="relative">
      <p className="sr-only">
        {label}: {summary}. {s.alert ? `${s.alert} decision(s) need you.` : "Nothing needs you."} {s.correcting ? "A correction is in progress." : ""}{" "}
        {s.repairing ? "An acceptance check is being repaired." : ""}
      </p>
      {/* desktop / tablet: horizontal flow */}
      <svg viewBox="0 0 990 230" className="hidden w-full md:block" role="img" aria-label={`${label}: ${summary}`}>
        {NODES.slice(0, -1).map((a, i) => {
          const b = NODES[i + 1]!;
          const [x1, y1] = H_POS[a];
          const [x2, y2] = H_POS[b];
          const pulse = isPulse(s.pulses, a, b);
          const flowing = s.counts[b] > 0 || s.active[b];
          return (
            <g key={a}>
              <line x1={x1 + 30} y1={y1} x2={x2 - (b === "gate" ? 40 : 30)} y2={y2} stroke="var(--color-line-2)" strokeWidth={2} />
              {flowing || pulse ? (
                <line
                  className={cx("flow-edge", pulse && "is-pulse")}
                  x1={x1 + 30}
                  y1={y1}
                  x2={x2 - (b === "gate" ? 40 : 30)}
                  y2={y2}
                  stroke={TONE[b]}
                  strokeWidth={2}
                  strokeDasharray="6 10"
                />
              ) : null}
            </g>
          );
        })}
        {/* correction path: gate -> builder (only while a task is actually being corrected) */}
        <path
          d={`M ${H_POS.gate[0] - 20} ${H_POS.gate[1] - 34} C ${H_POS.gate[0] - 80} 20, ${H_POS.builder[0] + 60} 20, ${H_POS.builder[0] + 10} ${H_POS.builder[1] - 28}`}
          fill="none"
          stroke={s.correcting ? "var(--color-bad)" : "var(--color-line)"}
          strokeOpacity={s.correcting ? 0.9 : 0.5}
          strokeWidth={s.correcting ? 2 : 1}
          strokeDasharray="4 6"
          className={cx(s.correcting && "flow-edge is-pulse")}
        />
        <text x={(H_POS.gate[0] + H_POS.builder[0]) / 2} y={30} textAnchor="middle" fontSize={11} fill={s.correcting ? "var(--color-bad)" : "var(--color-mute)"} letterSpacing={1}>
          {s.correcting ? "CORRECTING" : "correction path"}
        </text>
        {/* repair path: gate -> verifier (a defective acceptance check goes back to its author) */}
        <path
          d={`M ${H_POS.gate[0] + 20} ${H_POS.gate[1] + 34} C ${H_POS.gate[0] + 50} 210, ${H_POS.verifier[0] - 40} 210, ${H_POS.verifier[0] - 8} ${H_POS.verifier[1] + 26}`}
          fill="none"
          stroke={s.repairing ? "var(--color-verifier)" : "var(--color-line)"}
          strokeOpacity={s.repairing ? 0.9 : 0.5}
          strokeWidth={s.repairing ? 2 : 1}
          strokeDasharray="4 6"
          className={cx(s.repairing && "flow-edge is-pulse")}
        />
        <text x={(H_POS.gate[0] + H_POS.verifier[0]) / 2} y={224} textAnchor="middle" fontSize={11} fill={s.repairing ? "var(--color-verifier)" : "var(--color-mute)"} letterSpacing={1}>
          {s.repairing ? "REPAIRING CHECK" : "check repair path"}
        </text>
        {NODES.map((n) => (
          <Node key={n} n={n} pos={H_POS[n]} s={s} big={n === "gate"} />
        ))}
      </svg>
      {/* phone: vertical flow */}
      <svg viewBox="0 0 330 670" className="block w-full md:hidden" role="img" aria-label={`${label}: ${summary}`}>
        {NODES.slice(0, -1).map((a, i) => {
          const b = NODES[i + 1]!;
          const pulse = isPulse(s.pulses, a, b);
          return (
            <line
              key={a}
              x1={V_POS[a][0]}
              y1={V_POS[a][1] + 28}
              x2={V_POS[b][0]}
              y2={V_POS[b][1] - (b === "gate" ? 38 : 28)}
              stroke={pulse || s.counts[b] > 0 ? TONE[b] : "var(--color-line-2)"}
              strokeWidth={2}
              strokeDasharray={pulse ? "6 8" : undefined}
              className={cx(pulse && "flow-edge is-pulse")}
            />
          );
        })}
        {NODES.map((n) => {
          const [x, y] = V_POS[n];
          return (
            <g key={n}>
              <Node n={n} pos={[x, y]} s={s} big={n === "gate"} hideLabel />
              <text x={x + 60} y={y - 2} fontSize={13} fill="var(--color-ink)" fontWeight={600}>
                {NODE_LABEL[n]}
                {s.active[n] ? " · working" : ""}
                {n === "owner" && s.alert ? ` · ${s.alert} waiting for you` : ""}
              </text>
              <text x={x + 60} y={y + 16} fontSize={11} fill="var(--color-mute)">
                {NODE_HELP[n].slice(0, 36)}
                {NODE_HELP[n].length > 36 ? "…" : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
