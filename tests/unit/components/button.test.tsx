import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button, buttonVariants } from '@/components/ui/button';

describe('Button Component', () => {
  describe('Rendering', () => {
    it('renders with default variant', () => {
      render(<Button>Click me</Button>);
      expect(screen.queryByRole('button', { name: 'Click me' })).toBeInTheDocument();
    });

    it('renders children correctly', () => {
      render(<Button>Test Content</Button>);
      expect(screen.queryByText('Test Content')).toBeInTheDocument();
    });

    it('renders with custom className', () => {
      render(<Button className="custom-class">Button</Button>);
      expect(screen.getByRole('button')).toHaveClass('custom-class');
    });

    it('renders as button element by default', () => {
      render(<Button>Button</Button>);
      expect(screen.getByRole('button').tagName).toBe('BUTTON');
    });
  });

  describe('Variants', () => {
    it('applies default variant styles', () => {
      render(<Button variant="default">Default</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('inline-flex');
      expect(button).toHaveClass('items-center');
    });

    it('applies destructive variant styles', () => {
      render(<Button variant="destructive">Delete</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-destructive');
    });

    it('applies outline variant styles', () => {
      render(<Button variant="outline">Outline</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('border');
      expect(button).toHaveClass('bg-background');
    });

    it('applies secondary variant styles', () => {
      render(<Button variant="secondary">Secondary</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-secondary');
    });

    it('applies ghost variant styles', () => {
      render(<Button variant="ghost">Ghost</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('hover:bg-accent/60');
    });

    it('applies link variant styles', () => {
      render(<Button variant="link">Link</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('text-primary');
      expect(button).toHaveClass('underline-offset-4');
    });
  });

  describe('Sizes', () => {
    it('applies default size', () => {
      render(<Button size="default">Default Size</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-9');
      expect(button).toHaveClass('px-4');
    });

    it('applies small size', () => {
      render(<Button size="sm">Small</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-8');
    });

    it('applies large size', () => {
      render(<Button size="lg">Large</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-10');
    });

    it('applies icon size', () => {
      render(<Button size="icon">Icon</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-9');
      expect(button).toHaveClass('w-9');
    });
  });

  describe('States', () => {
    it('can be disabled', () => {
      render(<Button disabled>Disabled</Button>);
      expect(screen.getByRole('button')).toBeDisabled();
    });

    it('has disabled styles when disabled', () => {
      render(<Button disabled>Disabled</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('disabled:opacity-50');
    });

    it('prevents click when disabled', () => {
      const handleClick = vi.fn();
      render(<Button disabled onClick={handleClick}>Disabled</Button>);
      
      fireEvent.click(screen.getByRole('button'));
      expect(handleClick).not.toHaveBeenCalled();
    });
  });

  describe('Events', () => {
    it('calls onClick handler when clicked', () => {
      const handleClick = vi.fn();
      render(<Button onClick={handleClick}>Click Me</Button>);
      
      fireEvent.click(screen.getByRole('button'));
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('passes event to onClick handler', () => {
      const handleClick = vi.fn();
      render(<Button onClick={handleClick}>Click Me</Button>);
      
      fireEvent.click(screen.getByRole('button'));
      expect(handleClick).toHaveBeenCalledWith(expect.objectContaining({
        type: 'click',
      }));
    });
  });

  describe('Accessibility', () => {
    it('supports aria-label', () => {
      render(<Button aria-label="Custom label">Icon</Button>);
      expect(screen.queryByLabelText('Custom label')).toBeInTheDocument();
    });

    it('supports aria-pressed', () => {
      render(<Button aria-pressed="true">Toggle</Button>);
      expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    });

    it('has focus visible styles', () => {
      render(<Button>Focus</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('focus-visible:outline-none');
      expect(button).toHaveClass('focus-visible:ring-1');
    });
  });

  describe('Types', () => {
    it('can be submit type', () => {
      render(<Button type="submit">Submit</Button>);
      expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
    });

    it('can be reset type', () => {
      render(<Button type="reset">Reset</Button>);
      expect(screen.getByRole('button')).toHaveAttribute('type', 'reset');
    });

    it('can explicitly set type button', () => {
      render(<Button type="button">Button</Button>);
      expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
    });
  });

  describe('buttonVariants', () => {
    it('exports buttonVariants function', () => {
      expect(typeof buttonVariants).toBe('function');
    });

    it('generates class string', () => {
      const classes = buttonVariants({ variant: 'default', size: 'default' });
      expect(typeof classes).toBe('string');
      expect(classes.length).toBeGreaterThan(0);
    });
  });
});