/**
 * React 19 compatibility shim.
 *
 * React 19's type definitions removed the global `JSX` namespace and
 * moved it to `React.JSX`. The codebase still has many explicit
 * `JSX.Element` return-type annotations; this shim restores the global
 * namespace by aliasing it back to `React.JSX` so they keep compiling.
 *
 * New code should prefer `React.JSX.Element` or `ReactElement`.
 */
import type { JSX as ReactJSX } from 'react';

declare global {
  namespace JSX {
    type ElementType = ReactJSX.ElementType;
    interface Element extends ReactJSX.Element {}
    interface ElementClass extends ReactJSX.ElementClass {}
    interface ElementAttributesProperty
      extends ReactJSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute
      extends ReactJSX.ElementChildrenAttribute {}
    type LibraryManagedAttributes<C, P> = ReactJSX.LibraryManagedAttributes<
      C,
      P
    >;
    interface IntrinsicAttributes extends ReactJSX.IntrinsicAttributes {}
    interface IntrinsicClassAttributes<T>
      extends ReactJSX.IntrinsicClassAttributes<T> {}
    interface IntrinsicElements extends ReactJSX.IntrinsicElements {}
  }
}

export {};
