import type { Meta, StoryObj } from "@storybook/react-vite";
import { Breadcrumbs, Combobox, FilterChip, FormField, GroupSelect, Input, Pagination, SearchBar, Select, SortSelect } from "../src";

const meta = {
  title: "Aevo/Controls",
  parameters: { layout: "padded" }
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const WorkspaceControls: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 20, width: "min(760px, 90vw)" }}>
      <Breadcrumbs items={[{ label: "Hub", href: "/" }, { label: "Organization settings" }]} />
      <SearchBar placeholder="Search members, stores, or applications" />
      <FormField label="Organization" htmlFor="story-organization">
        <Combobox id="story-organization" options={[{ value: "sports", label: "Aevo Sports" }, { value: "academy", label: "Aevo Academy" }, { value: "retail", label: "Aevo Retail" }]} />
      </FormField>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <FilterChip active>Active</FilterChip>
        <FilterChip>Needs review</FilterChip>
        <FilterChip>Store scoped</FilterChip>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <SortSelect options={[{ value: "updated", label: "Recently updated" }, { value: "name", label: "Name" }]} />
        <GroupSelect options={[{ value: "store", label: "Store" }, { value: "role", label: "Role" }]} />
      </div>
      <FormField label="Organization name" htmlFor="story-org" hint="This name is visible to staff."><Input id="story-org" defaultValue="Aevo Sports" /></FormField>
      <FormField label="Access level" htmlFor="story-access"><Select id="story-access" defaultValue="manager"><option value="manager">Organization manager</option><option value="staff">Staff</option></Select></FormField>
      <Pagination page={2} pageCount={8} onPageChange={() => undefined} />
    </div>
  )
};
