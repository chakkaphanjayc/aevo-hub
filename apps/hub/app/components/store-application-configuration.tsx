import type {
  HubApplicationConfigField,
  HubApplicationConfigSchema,
  StoreApplicationAccessSummary
} from "@aevocado/contracts";
import { Button, Input, Select } from "@aevocado/design-system";
import { Form } from "react-router";

function configurationValue(schema: HubApplicationConfigSchema, field: HubApplicationConfigField): string {
  const value = schema.config[field.key] ?? field.defaultValue ?? "";
  return String(value);
}

export function StoreApplicationConfigurationForm({
  action,
  applicationCode,
  schema,
  canManage,
  busy
}: {
  action: string;
  applicationCode: StoreApplicationAccessSummary["applicationCode"];
  schema: HubApplicationConfigSchema;
  canManage: boolean;
  busy: boolean;
}) {
  return <Form method="post" action={action} className="aevo-app-config-panel" aria-busy={busy || undefined}>
    <input type="hidden" name="intent" value="update-application-config" />
    <input type="hidden" name="applicationCode" value={applicationCode} />
    <input type="hidden" name="schemaRef" value={schema.schemaRef} />
    <input type="hidden" name="schemaVersion" value={schema.schemaVersion} />
    <div className="aevo-app-config-panel__heading">
      <div>
        <span className="aevo-eyebrow">Typed app configuration · {schema.schemaRef}</span>
        <h3>{schema.label}</h3>
        <p>{schema.description}</p>
      </div>
      <span className="aevo-status aevo-status--neutral">v{schema.schemaVersion}</span>
    </div>
    <div className="aevo-app-config-fields">
      {schema.fields.map((field) => {
        const value = configurationValue(schema, field);
        if (field.type === "boolean") {
          return <label className="aevo-config-field" key={field.key}>
            <span>{field.label}</span>
            <Select name={`config.${field.key}`} defaultValue={value} disabled={!canManage || busy}>
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </Select>
            <small>{field.description}</small>
          </label>;
        }
        if (field.type === "select") {
          return <label className="aevo-config-field" key={field.key}>
            <span>{field.label}</span>
            <Select name={`config.${field.key}`} defaultValue={value} required={field.required} disabled={!canManage || busy}>
              <option value="" disabled={field.required}>Select an option</option>
              {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
            <small>{field.description}</small>
          </label>;
        }
        return <label className="aevo-config-field" key={field.key}>
          <span>{field.label}</span>
          <Input
            name={`config.${field.key}`}
            type={field.type === "integer" ? "number" : "text"}
            defaultValue={value}
            min={field.min}
            max={field.max}
            maxLength={field.maxLength}
            required={field.required}
            disabled={!canManage || busy}
          />
          <small>{field.description}</small>
        </label>;
      })}
    </div>
    <div className="aevo-form-actions">
      <span className="aevo-form-hint">Core validates this schema and stores only non-secret values.</span>
      {canManage ? <Button variant="secondary" type="submit" busy={busy} busyLabel="Saving config…">Save {schema.label}</Button> : null}
    </div>
  </Form>;
}
