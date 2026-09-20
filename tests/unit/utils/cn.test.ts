import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/utils';

describe('cn (classNames utility)', () => {
  describe('Basic functionality', () => {
    it('returns empty string for no arguments', () => {
      expect(cn()).toBe('');
    });

    it('returns single class name unchanged', () => {
      expect(cn('foo')).toBe('foo');
    });

    it('joins multiple class names', () => {
      expect(cn('foo', 'bar', 'baz')).toBe('foo bar baz');
    });

    it('handles undefined values', () => {
      expect(cn('foo', undefined, 'bar')).toBe('foo bar');
    });

    it('handles null values', () => {
      expect(cn('foo', null, 'bar')).toBe('foo bar');
    });

    it('handles false values', () => {
      expect(cn('foo', false, 'bar')).toBe('foo bar');
    });

    it('handles empty strings', () => {
      expect(cn('foo', '', 'bar')).toBe('foo bar');
    });
  });

  describe('Conditional classes', () => {
    it('includes class when condition is true', () => {
      expect(cn('base', true && 'conditional')).toBe('base conditional');
    });

    it('excludes class when condition is false', () => {
      expect(cn('base', false && 'conditional')).toBe('base');
    });

    it('handles complex conditionals', () => {
      const isActive = true;
      const isDisabled = false;
      const size = 'large';

      expect(cn(
        'btn',
        isActive && 'btn-active',
        isDisabled && 'btn-disabled',
        size === 'large' && 'btn-lg'
      )).toBe('btn btn-active btn-lg');
    });
  });

  describe('Object syntax', () => {
    it('includes classes with truthy values', () => {
      expect(cn({ foo: true, bar: false, baz: true })).toBe('foo baz');
    });

    it('handles numeric truthy values', () => {
      expect(cn({ foo: 1, bar: 0 })).toBe('foo');
    });

    it('handles string truthy values', () => {
      expect(cn({ foo: 'yes', bar: '' })).toBe('foo');
    });

    it('combines objects with strings', () => {
      expect(cn('base', { active: true, disabled: false })).toBe('base active');
    });
  });

  describe('Array syntax', () => {
    it('flattens arrays of class names', () => {
      expect(cn(['foo', 'bar'])).toBe('foo bar');
    });

    it('handles nested arrays', () => {
      expect(cn(['foo', ['bar', 'baz']])).toBe('foo bar baz');
    });

    it('filters out falsy values in arrays', () => {
      expect(cn(['foo', null, undefined, false, 'bar'])).toBe('foo bar');
    });
  });

  describe('Tailwind merge functionality', () => {
    it('merges conflicting Tailwind classes (last wins)', () => {
      expect(cn('p-4', 'p-8')).toBe('p-8');
    });

    it('merges conflicting margin classes', () => {
      expect(cn('mt-4', 'mt-8')).toBe('mt-8');
    });

    it('merges conflicting width classes', () => {
      expect(cn('w-full', 'w-64')).toBe('w-64');
    });

    it('merges conflicting text color classes', () => {
      expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
    });

    it('merges conflicting background color classes', () => {
      expect(cn('bg-red-500', 'bg-blue-500')).toBe('bg-blue-500');
    });

    it('keeps non-conflicting classes', () => {
      expect(cn('p-4', 'm-4', 'text-lg')).toBe('p-4 m-4 text-lg');
    });

    it('handles responsive prefixes', () => {
      expect(cn('p-4', 'md:p-4', 'md:p-8')).toBe('p-4 md:p-8');
    });

    it('handles state prefixes', () => {
      expect(cn('hover:bg-red-500', 'hover:bg-blue-500')).toBe('hover:bg-blue-500');
    });

    it('merges flex direction classes', () => {
      expect(cn('flex-row', 'flex-col')).toBe('flex-col');
    });

    it('keeps different axis classes', () => {
      expect(cn('px-4', 'py-2')).toBe('px-4 py-2');
    });
  });

  describe('Complex combinations', () => {
    it('handles typical component pattern', () => {
      const variant: string = 'primary';
      const size: string = 'md';
      const disabled = false;
      const className = 'custom-class';

      expect(cn(
        'btn',
        variant === 'primary' && 'btn-primary',
        variant === 'secondary' && 'btn-secondary',
        size === 'sm' && 'btn-sm',
        size === 'md' && 'btn-md',
        size === 'lg' && 'btn-lg',
        disabled && 'btn-disabled',
        className
      )).toBe('btn btn-primary btn-md custom-class');
    });

    it('handles shadcn-style variant patterns', () => {
      const baseStyles = 'inline-flex items-center justify-center rounded-md text-sm font-medium';
      const variants = {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
      };

      const result = cn(baseStyles, variants.default);
      expect(result).toContain('inline-flex');
      expect(result).toContain('bg-primary');
      expect(result).toContain('hover:bg-primary/90');
    });

    it('properly overrides base styles', () => {
      expect(cn(
        'bg-gray-100 p-4 rounded',
        'bg-blue-500',
        'p-8'
      )).toBe('rounded bg-blue-500 p-8');
    });
  });

  describe('Edge cases', () => {
    it('handles very long class lists', () => {
      const classes = Array.from({ length: 50 }, (_, i) => `class-${i}`);
      const result = cn(...classes);
      expect(result.split(' ')).toHaveLength(50);
    });

    it('handles special characters in class names', () => {
      expect(cn('[&>*]:ml-2', 'before:content-[""]')).toBe('[&>*]:ml-2 before:content-[""]');
    });

    it('handles arbitrary values', () => {
      expect(cn('w-[200px]', 'h-[100px]')).toBe('w-[200px] h-[100px]');
    });

    it('handles negative values', () => {
      expect(cn('-mt-4', '-ml-2')).toBe('-mt-4 -ml-2');
    });

    it('merges negative and positive margin', () => {
      expect(cn('mt-4', '-mt-4')).toBe('-mt-4');
    });
  });
});