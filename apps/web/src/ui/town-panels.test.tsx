import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RelationshipsPanel } from './relationships-panel';
import { ShowcasePanel } from './showcase-panel';
import { TownHistoryPanel } from './town-history-panel';

describe('town observation panels', () => {
  it('uses resident language without online or mock claims', () => {
    render(<RelationshipsPanel relationships={[]} residents={[]} loading={false} />);
    expect(screen.getByText(/小镇常驻居民/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/在线用户|模拟居民|mock/i);
  });

  it('renders a useful empty history state', () => {
    render(<TownHistoryPanel events={[]} residents={[]} loading={false} />);
    expect(screen.getByText(/还没有小镇动态/)).toBeInTheDocument();
  });

  it('requires explicit public confirmation and limits stall selection to three items', () => {
    const onSave = vi.fn();
    render(<ShowcasePanel items={[]} sessionId="session-1" loading={false} onSave={onSave} onDelete={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '我的帽子' } });
    fireEvent.change(screen.getByLabelText('公开内容'), { target: { value: '最喜欢的像素帽' } });
    expect(screen.getByRole('button', { name: '添加公开展示' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/确认公开/));
    fireEvent.click(screen.getByRole('button', { name: '添加公开展示' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ isPublic: true, title: '我的帽子' }));
  });
});
