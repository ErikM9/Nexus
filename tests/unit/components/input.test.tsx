import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input } from '@/components/ui/input';

describe('Input Component', () => {
  describe('Rendering', () => {
    it('renders a text input by default', () => {
      render(<Input />);
      expect(screen.queryByRole('textbox')).toBeInTheDocument();
    });

    it('renders with placeholder', () => {
      render(<Input placeholder="Enter text..." />);
      expect(screen.queryByPlaceholderText('Enter text...')).toBeInTheDocument();
    });

    it('renders with custom className', () => {
      render(<Input className="custom-input" />);
      expect(screen.getByRole('textbox')).toHaveClass('custom-input');
    });

    it('renders with default value', () => {
      render(<Input defaultValue="Default text" />);
      expect(screen.getByRole('textbox')).toHaveValue('Default text');
    });
  });

  describe('Input Types', () => {
    it('renders as text input', () => {
      render(<Input type="text" />);
      expect(screen.getByRole('textbox')).toHaveAttribute('type', 'text');
    });

    it('renders as password input', () => {
      render(<Input type="password" />);
      const input = document.querySelector('input[type="password"]');
      expect(input).toBeInTheDocument();
    });

    it('renders as email input', () => {
      render(<Input type="email" />);
      expect(screen.getByRole('textbox')).toHaveAttribute('type', 'email');
    });

    it('renders as number input', () => {
      render(<Input type="number" />);
      expect(screen.getByRole('spinbutton')).toHaveAttribute('type', 'number');
    });

    it('renders as search input', () => {
      render(<Input type="search" />);
      expect(screen.getByRole('searchbox')).toHaveAttribute('type', 'search');
    });

    it('renders as file input', () => {
      render(<Input type="file" />);
      const input = document.querySelector('input[type="file"]');
      expect(input).toBeInTheDocument();
    });
  });

  describe('Interactions', () => {
    it('handles change events', async () => {
      const handleChange = vi.fn();
      render(<Input onChange={handleChange} />);
      
      const input = screen.getByRole('textbox');
      await userEvent.type(input, 'test');
      
      expect(handleChange).toHaveBeenCalled();
    });

    it('updates value on type', async () => {
      render(<Input />);
      
      const input = screen.getByRole('textbox');
      await userEvent.type(input, 'hello world');
      
      expect(input).toHaveValue('hello world');
    });

    it('handles focus events', () => {
      const handleFocus = vi.fn();
      render(<Input onFocus={handleFocus} />);
      
      fireEvent.focus(screen.getByRole('textbox'));
      expect(handleFocus).toHaveBeenCalledTimes(1);
    });

    it('handles blur events', () => {
      const handleBlur = vi.fn();
      render(<Input onBlur={handleBlur} />);
      
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      fireEvent.blur(input);
      
      expect(handleBlur).toHaveBeenCalledTimes(1);
    });

    it('handles keydown events', () => {
      const handleKeyDown = vi.fn();
      render(<Input onKeyDown={handleKeyDown} />);
      
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
      expect(handleKeyDown).toHaveBeenCalledTimes(1);
    });
  });

  describe('Controlled vs Uncontrolled', () => {
    it('works as controlled input', async () => {
      const ControlledInput = () => {
        const [value, setValue] = React.useState('');
        return (
          <Input 
            value={value} 
            onChange={(e) => setValue(e.target.value)} 
          />
        );
      };
      
      render(<ControlledInput />);
      const input = screen.getByRole('textbox');
      
      await userEvent.type(input, 'controlled');
      expect(input).toHaveValue('controlled');
    });

    it('works as uncontrolled input', async () => {
      render(<Input defaultValue="initial" />);
      const input = screen.getByRole('textbox');
      
      await userEvent.clear(input);
      await userEvent.type(input, 'uncontrolled');
      
      expect(input).toHaveValue('uncontrolled');
    });
  });

  describe('States', () => {
    it('shows disabled state', () => {
      render(<Input disabled />);
      expect(screen.getByRole('textbox')).toBeDisabled();
    });

    it('shows readonly state', () => {
      render(<Input readOnly value="readonly" />);
      expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    });

    it('shows required state', () => {
      render(<Input required />);
      expect(screen.getByRole('textbox')).toBeRequired();
    });
  });

  describe('Accessibility', () => {
    it('supports aria-label', () => {
      render(<Input aria-label="Username input" />);
      expect(screen.queryByLabelText('Username input')).toBeInTheDocument();
    });

    it('supports aria-describedby', () => {
      render(
        <>
          <Input aria-describedby="helper-text" />
          <span id="helper-text">Enter your username</span>
        </>
      );
      expect(screen.getByRole('textbox')).toHaveAttribute('aria-describedby', 'helper-text');
    });

    it('supports aria-invalid', () => {
      render(<Input aria-invalid="true" />);
      expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
    });

    it('associates with label via id', () => {
      render(
        <>
          <label htmlFor="username">Username</label>
          <Input id="username" />
        </>
      );
      expect(screen.queryByLabelText('Username')).toBeInTheDocument();
    });
  });

  describe('Styling', () => {
    it('has base input styles', () => {
      render(<Input />);
      const input = screen.getByRole('textbox');
      expect(input).toHaveClass('flex');
      expect(input).toHaveClass('rounded-md');
      expect(input).toHaveClass('border');
    });

    it('has focus styles', () => {
      render(<Input />);
      const input = screen.getByRole('textbox');
      expect(input).toHaveClass('focus-visible:outline-none');
    });

    it('has disabled styles', () => {
      render(<Input disabled />);
      const input = screen.getByRole('textbox');
      expect(input).toHaveClass('disabled:opacity-50');
    });
  });

  describe('Attributes', () => {
    it('supports maxLength', () => {
      render(<Input maxLength={10} />);
      expect(screen.getByRole('textbox')).toHaveAttribute('maxLength', '10');
    });

    it('supports minLength', () => {
      render(<Input minLength={3} />);
      expect(screen.getByRole('textbox')).toHaveAttribute('minLength', '3');
    });

    it('supports pattern', () => {
      render(<Input pattern="[A-Za-z]+" />);
      expect(screen.getByRole('textbox')).toHaveAttribute('pattern', '[A-Za-z]+');
    });

    it('supports autoComplete', () => {
      render(<Input autoComplete="email" />);
      expect(screen.getByRole('textbox')).toHaveAttribute('autoComplete', 'email');
    });

    it('supports name attribute', () => {
      render(<Input name="email" />);
      expect(screen.getByRole('textbox')).toHaveAttribute('name', 'email');
    });
  });

  describe('Forwarded Ref', () => {
    it('forwards ref to input element', () => {
      const ref = vi.fn();
      render(<Input ref={ref} />);
      expect(ref).toHaveBeenCalled();
    });
  });
});