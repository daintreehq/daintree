import { KitToggleGroup, KitSplitButton } from "./kitButtonGroups";
import { KitColorPicker, KitColorSwatch } from "./kitColorPicker";
import { KitForm, KitFormStatus, KitSchemaForm } from "./kitForm";
import { KitRangeSlider } from "./kitRangeSlider";
import { KitDateTimePicker, KitTimePicker } from "./kitTimePicker";

export { normalizeRange } from "./kitRangeSlider";
export { schemaFields, type SchemaField } from "./kitForm";

export const pluginKitPickersForms = {
  ColorSwatch: KitColorSwatch,
  ColorPicker: KitColorPicker,
  TimePicker: KitTimePicker,
  DateTimePicker: KitDateTimePicker,
  RangeSlider: KitRangeSlider,
  ToggleGroup: KitToggleGroup,
  SplitButton: KitSplitButton,
  Form: KitForm,
  FormStatus: KitFormStatus,
  SchemaForm: KitSchemaForm,
};
