import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Card, StatusBadge } from "../src";

const meta = {
  title: "Aevo/Primitives",
  component: Button,
  parameters: { layout: "centered" }
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Actions: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
      <Button variant="primary">Save changes</Button>
      <Button variant="secondary">Review</Button>
      <Button variant="ghost">Cancel</Button>
      <Button variant="danger">Revoke access</Button>
      <Button variant="primary" busy busyLabel="Saving…">Save changes</Button>
    </div>
  )
};

export const Surfaces: Story = {
  render: () => (
    <Card style={{ display: "grid", gap: 16, width: 360 }}>
      <StatusBadge tone="success">Connected</StatusBadge>
      <strong>Organization control plane</strong>
      <span style={{ color: "var(--aevo-muted)" }}>A reusable glass surface with semantic status feedback.</span>
    </Card>
  )
};
