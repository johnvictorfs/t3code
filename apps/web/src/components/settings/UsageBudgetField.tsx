import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";

/** Empty means no budget. Keyed by the saved value so a change from elsewhere resets the draft. */
export function UsageBudgetField({
  id,
  value,
  onCommit,
}: {
  readonly id: string;
  readonly value: number | undefined;
  readonly onCommit: (value: number | undefined) => void;
}) {
  return (
    <NumberField
      key={value ?? "unset"}
      id={id}
      size="sm"
      className="w-32"
      defaultValue={value}
      min={0}
      format={{ style: "currency", currency: "USD" }}
      onValueCommitted={(next) => {
        const budget = next === null || next <= 0 ? undefined : Math.round(next * 100) / 100;
        if (budget !== value) {
          onCommit(budget);
        }
      }}
    >
      <NumberFieldGroup>
        <NumberFieldInput aria-label="Usage budget in US dollars" placeholder="Not set" />
      </NumberFieldGroup>
    </NumberField>
  );
}
