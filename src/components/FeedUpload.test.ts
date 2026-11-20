import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FeedUpload } from './FeedUpload';

describe('the feed upload box, before a file is chosen', () => {
  const html = renderToStaticMarkup(createElement(FeedUpload, { orgId: '0b5c0f0e-1111-4222-8333-444455556666' }));

  it('has a labelled picker for .blm files and an Upload button', () => {
    const input = html.match(/<input[^>]*type="file"[^>]*>/)?.[0] ?? '';
    expect(input).toMatch(/accept="\.blm"/);
    const id = input.match(/\sid="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<label class="field" for="${id}">Listing file (.blm)`);
    // the explanation is tied to the picker, so a screen reader reads it with the field
    const describedBy = input.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toMatch(/<button type="button" class="btn accent">Upload<\/button>/);
  });

  it('says what an upload does to listings already on Streetkey', () => {
    expect(html).toContain('listings from your last upload by hand that are not in this file are withdrawn');
    expect(html).toContain('Listings sent with a feed key are not affected.');
  });

  it('keeps an empty status region on the page for the progress and the result, and shows no error', () => {
    expect(html).toContain('<div class="fu-status" role="status"></div>');
    expect(html).not.toContain('role="alert"');
    // plain wording: no em dashes
    expect(html).not.toContain('—');
  });
});
