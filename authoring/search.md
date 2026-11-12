# Search: drive the site's own controls and confirm they took

Search and filter tools fail quietly: the query box accepted the text, the page showed something, and it was
the wrong thing. Build for confirmation.

## Prefer the site's own URL

Run one manual search and look at the address. If it is `/search?q=term&category=books`, build that URL in
the tool from encoded inputs. It is more stable than typing into boxes and clicking, and the same URL works in
a test. If the state is not in the URL, drive the controls by label or role instead of by position.

## Map inputs to controls

Write down every filter the site offers, then decide which become inputs.

- Free text becomes `string` with `minLength: 1`. Blank is `invalid_input`.
- A fixed list on the site (category, sort order) becomes an `enum` of the site's own values, copied from the
  page. A value the site does not know is `invalid_input`, never a silent fallback to "all".
- Ranges (price, date) become two optional fields; validate `min <= max` yourself.
- Leave out anything you do not need. Each input is something to test and something that can break.

## Apply and read back

After applying a filter or sort, read the page's own statement of it (a "Showing results for", a selected
chip, a checked box, the URL) and compare it to what you intended. If it differs, throw with both values.
Without this, an ignored filter looks exactly like a good result.

## Read the answer

Use `wm.waitForOutcome(page, { results, empty, error })`. Branch on it:

- `results`: read the rows.
- `empty`: return the empty list. This is a normal answer.
- `error`: throw with the site's message, not a generic one.

Also notice "did you mean" and zero-hit pages that silently show related items: an empty-state selector
should match the site's real no-results message, and rows must come from the results container only.

## Result fields

Return each row's stable id or canonical URL when there is one, so callers can look a row up again, and the
fields that identify it to a person (title, price, one line of context). Keep the order the site gave.

## Test it

A query with several hits, a narrow query with one or two, a nonsense query (`empty`), a blank query
(`invalid_input`), a query with punctuation and non-ASCII characters, and each filter value once. If the
search pages, add the paging cases from the `pagination` guide.
