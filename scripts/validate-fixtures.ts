import { fixtureCases } from '../src/shared/fixtures/index.js';

for (const fixture of fixtureCases) {
  // Check the serialized wire form as well as the in-memory fixture.
  fixture.schema.parse(JSON.parse(JSON.stringify(fixture.value)));
}
console.log(`Validated ${fixtureCases.length} synthetic contract fixtures and their JSON wire forms.`);
