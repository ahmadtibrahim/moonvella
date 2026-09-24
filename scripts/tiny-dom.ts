/**
 * A DOLLOP OF DOM, JUST ENOUGH TO DRIVE THE PACKAGING FORM'S SUBMIT HANDLERS.
 *
 * WHAT THIS IS FOR. A carton row is stored in the unit it was typed in and shown
 * in the admin's unit, and the translation happens in the browser, in a submit
 * handler (`app/components/product/packagingRows.ts`). When that translation is
 * wrong it fails SILENTLY: re-expressing a stored 30 cm as the 11.81 in that is
 * on screen would store 29.9974 cm, and nothing throws, nothing looks wrong, and
 * every quote that reads that carton afterwards is quietly wrong.
 *
 * The suite that would catch this by driving a real browser is `verify-editor-ui`,
 * and it is SKIPPED whenever the owner's password is not in the environment —
 * which is the normal case, because this project does not put the owner's
 * password in a file. So the handlers are driven directly instead, against this.
 *
 * WHAT IT IS NOT. It is not a browser, and it is not a DOM implementation. It
 * supports exactly the four things those two handlers touch — `querySelectorAll`
 * with an attribute selector, `querySelector`, `closest`, and `dataset` — and its
 * selector matching understands only a tag name and `[attr]` / `[attr="value"]`
 * clauses. A handler that started using a selector outside that set would find
 * nothing here and FAIL a check, which is the failure mode to want: loud rather
 * than silent, and never a false pass.
 *
 * Everything it does model, it models the way a browser does, because that is
 * the only reason driving it proves anything. In particular `dataset.stored` and
 * the attribute `data-stored` are one value under two names, and writing either
 * is reading the other — a shim that kept them separate would let a handler pass
 * here and lose the figure in a document.
 */

export type Attributes = Record<string, string>;

/** `storedUnit` → `data-stored-unit`, the rule the DOM actually uses. */
function toAttribute(property: string): string {
  return `data-${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

export class FakeElement {
  readonly tagName: string;
  readonly attributes: Attributes;
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  /** The current value of a form control, as a browser keeps it: NOT an attribute. */
  value = "";

  constructor(tagName: string, attributes: Attributes = {}) {
    this.tagName = tagName;
    this.attributes = attributes;
  }

  /**
   * The element's `data-*` attributes, read and written under their camelCase
   * names. A view rather than a copy: the attribute map stays the one place the
   * value lives.
   */
  get dataset(): Record<string, string | undefined> {
    // Arrow handlers, so `this` is the element rather than the proxy — which is
    // what makes `field.dataset.stored` and `data-stored` one value.
    return new Proxy({} as Record<string, string | undefined>, {
      get: (_target, property: string) => this.attributes[toAttribute(property)],
      set: (_target, property: string, value: string) => {
        this.attributes[toAttribute(property)] = value;
        return true;
      },
    });
  }

  append<T extends FakeElement>(child: T): T {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  /** Every descendant, in document order. */
  private descendants(): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.children) {
      found.push(child, ...child.descendants());
    }
    return found;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((element) => matches(element, selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector: string): FakeElement | null {
    if (matches(this, selector)) return this;
    return this.parent ? this.parent.closest(selector) : null;
  }
}

/** A `<select>`, which is the one element whose "value" is chosen from children. */
export class FakeSelect extends FakeElement {
  constructor(attributes: Attributes = {}) {
    super("select", attributes);
    // A `<select>` has no `value` attribute of its own: its value is whichever
    // option is chosen, starting with none.
    this.value = "";
  }

  get options(): FakeElement[] {
    return this.children.filter((child) => child.tagName === "option");
  }

  get selectedOptions(): FakeElement[] {
    const chosen = this.options.filter((option) => (option.attributes.value ?? "") === this.value);
    return chosen;
  }
}

/**
 * Does this element match the selector?
 *
 * A tag name and any number of `[attr]` / `[attr="value"]` clauses — the whole
 * of what the handlers ask for, and deliberately no more. See the header: an
 * unsupported selector finds nothing and fails loudly.
 */
function matches(element: FakeElement, selector: string): boolean {
  const parsed = /^([a-zA-Z]*)((?:\[[^\]]*\])*)$/.exec(selector.trim());
  if (!parsed) return false;

  const [, tag, clauseText] = parsed;
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;

  for (const clause of clauseText.matchAll(/\[([^\]]*)\]/g)) {
    const [name, quoted] = clause[1].split("=");
    const attribute = element.attributes[name];
    if (attribute === undefined) return false;
    if (quoted === undefined) continue;
    if (attribute !== quoted.replace(/^"|"$/g, "")) return false;
  }

  return true;
}

/**
 * `h("input", { name: "pkg_length" })` — a terse element builder.
 *
 * A `value` attribute also becomes the control's value, because that is what a
 * browser does with one: the editor seeds its hidden unit fields that way, and a
 * shim that left them empty would have the handlers reading "" and translating
 * against a unit nobody chose.
 */
export function h(tagName: string, attributes: Attributes = {}): FakeElement {
  const element = new FakeElement(tagName, attributes);
  element.value = attributes.value ?? "";
  return element;
}

export function select(attributes: Attributes = {}): FakeSelect {
  return new FakeSelect(attributes);
}
