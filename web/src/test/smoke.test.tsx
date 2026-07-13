import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

// Proves the component-test stack is wired: JSX transform, jsdom DOM, React
// Testing Library render, and the jest-dom matchers all work together. Real
// component tests build on exactly this setup.
function Greeting({ name }: { name: string }) {
  return <p>Hello, {name}</p>
}

describe('test harness smoke', () => {
  it('renders a component into jsdom and queries it', () => {
    render(<Greeting name="Bastion" />)
    expect(screen.getByText('Hello, Bastion')).toBeInTheDocument()
  })
})
