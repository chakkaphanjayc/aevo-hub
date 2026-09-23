import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, CommandMenu, DataTable, Dialog, Drawer, Toast, ToastRegion } from "../src";

const meta = {
  title: "Aevo/Overlays and data surfaces",
  parameters: { layout: "padded" }
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const InteractiveSurfaces: Story = {
  render: function InteractiveSurfacesStory() {
    const [dialogOpen, setDialogOpen] = useState(false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [commandOpen, setCommandOpen] = useState(false);

    return (
      <div style={{ display: "grid", gap: 20, width: "min(760px, 92vw)" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <Button variant="primary" onClick={() => setDialogOpen(true)}>Open dialog</Button>
          <Button variant="secondary" onClick={() => setDrawerOpen(true)}>Open drawer</Button>
          <Button variant="ghost" onClick={() => setCommandOpen(true)}>Open command menu</Button>
        </div>

        <DataTable caption="Recent access changes">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={{ textAlign: "left", padding: 12 }}>Member</th><th style={{ textAlign: "left", padding: 12 }}>State</th></tr></thead>
            <tbody><tr><td style={{ padding: 12 }}>Nicha S.</td><td style={{ padding: 12 }}>Assigned to POS</td></tr></tbody>
          </table>
        </DataTable>

        <ToastRegion>
          <Toast tone="success" title="Saved">The access change is ready to use.</Toast>
        </ToastRegion>

        <Dialog
          open={dialogOpen}
          title="Review access"
          description="Confirm the server-checked assignment before leaving this surface."
          onClose={() => setDialogOpen(false)}
          footer={<><Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => setDialogOpen(false)}>Confirm</Button></>}
        >
          <p style={{ margin: 0 }}>The member will receive access at the selected application scope.</p>
        </Dialog>

        <Drawer open={drawerOpen} title="Assignment details" onClose={() => setDrawerOpen(false)}>
          <p style={{ marginTop: 0 }}>Drawers keep supporting context available without changing the route.</p>
          <Button variant="secondary" onClick={() => setDrawerOpen(false)}>Close details</Button>
        </Drawer>

        <CommandMenu
          open={commandOpen}
          onClose={() => setCommandOpen(false)}
          items={[{ id: "settings", label: "Open settings", description: "Manage organization access", onSelect: () => setCommandOpen(false) }]}
        />
      </div>
    );
  }
};
