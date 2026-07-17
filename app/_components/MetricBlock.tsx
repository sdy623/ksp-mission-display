export function MetricBlock({
  label,
  value,
  unit,
  detail,
  accent = false,
}: {
  label: string;
  value: string;
  unit?: string;
  detail?: string;
  accent?: boolean;
}) {
  return (
    <div className={`metric-block ${accent ? "metric-accent" : ""}`}>
      <span>{label}</span>
      <strong>{value}{unit ? <small>{unit}</small> : null}</strong>
      {detail ? <em>{detail}</em> : null}
    </div>
  );
}
