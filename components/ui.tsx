"use client";

import { useId, useState, type ReactNode } from "react";

/** Briques d'interface partagées, pour que les écrans restent lisibles. */

export function Card({
  title, subtitle, action, children, className = "",
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-line bg-surface p-5 shadow-sm ${className}`}
    >
      {(title || action) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Field({
  label, hint, children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const inputClass =
  "w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-base " +
  "outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/25";

export function NumberInput({
  value, onChange, min, max, step = 1, suffix, ariaLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  ariaLabel?: string;
}) {
  // Ce que l'utilisateur est en train de taper, tant que le champ a le focus.
  // Sans cela, vider le champ pour retaper une valeur envoyait 0 au parent —
  // `Number("")` vaut 0 — et un budget passé à 0 ne remontait jamais.
  const [draft, setDraft] = useState<string | null>(null);
  const affiche = draft ?? (Number.isFinite(value) ? String(value) : "");

  return (
    <div className="relative">
      <input
        type="number"
        className={inputClass}
        value={affiche}
        min={min}
        max={max}
        step={step}
        aria-label={ariaLabel}
        onChange={(event) => {
          const saisie = event.target.value;
          setDraft(saisie);
          // Un champ vide, ou une saisie en cours (« - », « 1, »), ne vaut pas
          // zéro : on n'en propage rien et la dernière valeur valide tient.
          const next = Number(saisie);
          if (saisie.trim() !== "" && Number.isFinite(next)) onChange(next);
        }}
        onBlur={(event) => {
          setDraft(null);
          const next = Number(event.target.value);
          const valide = event.target.value.trim() !== "" && Number.isFinite(next);
          onChange(Math.min(max, Math.max(min, valide ? next : value)));
        }}
      />
      {suffix && (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted">
          {suffix}
        </span>
      )}
    </div>
  );
}

export function TextInput(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  ariaLabel?: string;
}) {
  return (
    <input
      type={props.type ?? "text"}
      className={inputClass}
      value={props.value}
      placeholder={props.placeholder}
      aria-label={props.ariaLabel}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

/** Groupe de boutons à sélection multiple, plus rapide qu'une liste de cases. */
export function ChipGroup<T extends string>({
  options, selected, onToggle, columns = 2,
}: {
  options: { value: T; label: string }[];
  selected: T[];
  onToggle: (value: T) => void;
  columns?: number;
}) {
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {options.map((option) => {
        const active = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(option.value)}
            className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition ${
              active
                ? "border-accent bg-accent-soft text-accent"
                : "border-line bg-canvas text-muted hover:border-accent/40"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Sélection unique présentée comme un segment, pour les échelles courtes. */
export function SegmentGroup<T extends string | number>({
  options, value, onChange,
}: {
  options: { value: T; label: string; hint?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`rounded-xl border px-2 py-2.5 text-center transition ${
              active
                ? "border-accent bg-accent-soft text-accent"
                : "border-line bg-canvas text-muted hover:border-accent/40"
            }`}
          >
            <span className="block text-sm font-medium">{option.label}</span>
            {option.hint && <span className="mt-0.5 block text-xs opacity-75">{option.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Slider({
  value, onChange, min = 0, max = 100, marks,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  marks?: { at: number; label: string }[];
}) {
  const id = useId();
  return (
    <div>
      <input
        id={id}
        type="range"
        className="w-full"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {marks && (
        <div className="mt-1 flex justify-between text-xs text-muted">
          {marks.map((mark) => (
            <span key={mark.at}>{mark.label}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export function Button({
  children, onClick, variant = "primary", disabled, type = "button", full,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  full?: boolean;
}) {
  const styles = {
    primary: "bg-accent text-white hover:opacity-90 disabled:opacity-50",
    secondary: "border border-line bg-surface hover:border-accent/40 disabled:opacity-50",
    ghost: "text-muted hover:text-ink disabled:opacity-50",
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed ${styles} ${full ? "w-full" : ""}`}
    >
      {children}
    </button>
  );
}

export function Stat({
  label, value, tone = "neutral", hint,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "accent";
  hint?: string;
}) {
  const color = {
    neutral: "text-ink",
    good: "text-good",
    warn: "text-warn",
    accent: "text-accent",
  }[tone];

  return (
    <div className="rounded-xl border border-line bg-canvas px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Notice({
  tone = "info", title, children,
}: {
  tone?: "info" | "warn";
  title?: string;
  children: ReactNode;
}) {
  const styles = tone === "warn"
    ? "border-warn/40 bg-warn/10"
    : "border-line bg-canvas";

  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${styles}`}>
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <div className="text-muted [&_a]:text-accent [&_a]:underline">{children}</div>
    </div>
  );
}
