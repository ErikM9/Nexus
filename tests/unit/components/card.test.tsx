import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  Card,
  CardHeader,
  CardFooter,
  CardContent,
} from '@/components/ui/card';

describe('Card Component', () => {
  describe('Card', () => {
    it('renders children', () => {
      render(<Card>Card content</Card>);
      expect(screen.queryByText('Card content')).toBeInTheDocument();
    });

    it('applies custom className', () => {
      render(<Card className="custom-card" data-testid="card">Content</Card>);
      expect(screen.getByTestId('card')).toHaveClass('custom-card');
    });

    it('has default styling', () => {
      render(<Card data-testid="card">Content</Card>);
      const card = screen.getByTestId('card');
      expect(card).toHaveClass('rounded-xl');
      expect(card).toHaveClass('border');
      expect(card).toHaveClass('bg-card');
    });

    it('renders as div by default', () => {
      render(<Card data-testid="card">Content</Card>);
      expect(screen.getByTestId('card').tagName).toBe('DIV');
    });

    it('supports additional props', () => {
      render(<Card data-custom="value" data-testid="card">Content</Card>);
      expect(screen.getByTestId('card')).toHaveAttribute('data-custom', 'value');
    });
  });

  describe('CardHeader', () => {
    it('renders children', () => {
      render(<CardHeader>Header content</CardHeader>);
      expect(screen.queryByText('Header content')).toBeInTheDocument();
    });

    it('applies padding and spacing', () => {
      render(<CardHeader data-testid="header">Header</CardHeader>);
      const header = screen.getByTestId('header');
      expect(header).toHaveClass('flex');
      expect(header).toHaveClass('flex-col');
      expect(header).toHaveClass('space-y-1.5');
      expect(header).toHaveClass('p-6');
    });

    it('applies custom className', () => {
      render(<CardHeader className="custom-header" data-testid="header">Header</CardHeader>);
      expect(screen.getByTestId('header')).toHaveClass('custom-header');
    });
  });

  describe('CardContent', () => {
    it('renders children', () => {
      render(<CardContent>Main content</CardContent>);
      expect(screen.queryByText('Main content')).toBeInTheDocument();
    });

    it('has padding styles', () => {
      render(<CardContent data-testid="content">Content</CardContent>);
      const content = screen.getByTestId('content');
      expect(content).toHaveClass('p-6');
      expect(content).toHaveClass('pt-0');
    });

    it('applies custom className', () => {
      render(<CardContent className="custom-content" data-testid="content">Content</CardContent>);
      expect(screen.getByTestId('content')).toHaveClass('custom-content');
    });
  });

  describe('CardFooter', () => {
    it('renders children', () => {
      render(<CardFooter>Footer content</CardFooter>);
      expect(screen.queryByText('Footer content')).toBeInTheDocument();
    });

    it('has flex layout', () => {
      render(<CardFooter data-testid="footer">Footer</CardFooter>);
      const footer = screen.getByTestId('footer');
      expect(footer).toHaveClass('flex');
      expect(footer).toHaveClass('items-center');
    });

    it('has padding styles', () => {
      render(<CardFooter data-testid="footer">Footer</CardFooter>);
      const footer = screen.getByTestId('footer');
      expect(footer).toHaveClass('p-6');
      expect(footer).toHaveClass('pt-0');
    });
  });

  describe('Complete Card', () => {
    it('renders a complete card with all parts', () => {
      render(
        <Card>
          <CardHeader>
            <p>Header content</p>
          </CardHeader>
          <CardContent>
            <p>Card body content</p>
          </CardContent>
          <CardFooter>
            <button>Action</button>
          </CardFooter>
        </Card>
      );

      expect(screen.queryByText('Header content')).toBeInTheDocument();
      expect(screen.queryByText('Card body content')).toBeInTheDocument();
      expect(screen.queryByText('Action')).toBeInTheDocument();
    });

    it('maintains proper hierarchy', () => {
      const { container } = render(
        <Card>
          <CardHeader>Header</CardHeader>
          <CardContent>Content</CardContent>
        </Card>
      );

      const card = container.firstChild;
      expect(card?.childNodes.length).toBe(2);
    });
  });

  describe('Ref Forwarding', () => {
    it('Card forwards ref', () => {
      let cardRef: HTMLDivElement | null = null;
      render(<Card ref={(el) => { cardRef = el; }}>Content</Card>);
      expect(cardRef).toBeInstanceOf(HTMLDivElement);
    });

    it('CardHeader forwards ref', () => {
      let headerRef: HTMLDivElement | null = null;
      render(<CardHeader ref={(el) => { headerRef = el; }}>Header</CardHeader>);
      expect(headerRef).toBeInstanceOf(HTMLDivElement);
    });
  });
});