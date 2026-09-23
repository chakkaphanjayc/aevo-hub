import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, EmptyState, ErrorState, LoadingState, OfflineState, PermissionDeniedState } from "../src";

const meta = {
  title: "Aevo/States",
  parameters: { layout: "centered" }
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const RecoveryStates: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 16, width: "min(560px, 90vw)" }}>
      <LoadingState title="Loading organization data" description="The server is resolving the current workspace." />
      <EmptyState title="No stores yet" description="Create the first store to continue." action={<Button variant="primary">Create store</Button>} />
      <ErrorState title="Could not load members" description="The request failed. Retry without losing the current page." action={<Button variant="secondary">Retry</Button>} />
      <OfflineState title="Read-only connection" description="Live changes are paused until the gateway is reachable again." />
      <PermissionDeniedState title="Access unavailable" description="Ask an organization manager to update the assignment." />
    </div>
  )
};
