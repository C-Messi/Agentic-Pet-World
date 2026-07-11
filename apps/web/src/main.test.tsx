import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('web bootstrap', () => {
  it('mounts the application root', async () => {
    document.body.innerHTML = '<div id="root"></div>';

    await import('./main');

    await waitFor(() => {
      expect(document.querySelector('#root > #app')).not.toBeNull();
    });
  });
});
