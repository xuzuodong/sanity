import {type Schema} from '@sanity/types'
import {isEqual} from 'lodash'
import {useCallback, useMemo, useState} from 'react'
import {useObservableCallback} from 'react-rx'
import {concat, EMPTY, iif, type Observable, of, timer} from 'rxjs'
import {
  catchError,
  debounce,
  distinctUntilChanged,
  filter,
  map,
  scan,
  switchMap,
  tap,
} from 'rxjs/operators'

import {useClient} from '../../../../../hooks'
import {
  createSearch,
  type SearchHit,
  type SearchOptions,
  type SearchTerms,
} from '../../../../../search'
import {DEFAULT_STUDIO_CLIENT_OPTIONS} from '../../../../../studioClient'
import {useWorkspace} from '../../../../workspace'
import {type SearchState} from '../types'
import {hasSearchableTerms} from '../utils/hasSearchableTerms'
import {getSearchableOmnisearchTypes} from '../utils/selectors'
import {useSearchMaxFieldDepth} from './useSearchMaxFieldDepth'

interface SearchRequest {
  debounceTime?: number
  options?: SearchOptions
  terms: SearchTerms
}

const DEFAULT_DEBOUNCE_TIME = 300 // ms

const INITIAL_SEARCH_STATE: SearchState = {
  error: null,
  hits: [],
  loading: false,
  terms: {
    query: '',
    types: [],
  },
}

function nonNullable<T>(v: T): v is NonNullable<T> {
  return v !== null
}

function sanitizeRequest(request: SearchRequest) {
  return {
    ...request,
    terms: {
      ...request.terms,
      filter: request.terms.filter?.trim(),
      query: request.terms.query.trim(),
    },
  }
}

export function useSearch({
  allowEmptyQueries,
  initialState,
  onComplete,
  onError,
  onStart,
  schema,
}: {
  allowEmptyQueries?: boolean
  initialState: SearchState
  onComplete?: (result: {hits: SearchHit[]; nextCursor: string | undefined}) => void
  onError?: (error: Error) => void
  onStart?: () => void
  schema: Schema
}): {
  handleSearch: (request: SearchRequest) => void
  searchState: SearchState
} {
  const [searchState, setSearchState] = useState(initialState)
  const client = useClient(DEFAULT_STUDIO_CLIENT_OPTIONS)
  const maxFieldDepth = useSearchMaxFieldDepth()
  const {unstable_enableNewSearch = false} = useWorkspace().search

  const search = useMemo(
    () =>
      createSearch(getSearchableOmnisearchTypes(schema), client, {
        tag: 'search.global',
        unique: true,
        unstable_enableNewSearch,
        maxDepth: maxFieldDepth,
      }),
    [client, maxFieldDepth, schema, unstable_enableNewSearch],
  )

  const handleQueryChange = useObservableCallback(
    (inputValue$: Observable<SearchRequest | null>) => {
      return inputValue$.pipe(
        // Ignore null values
        filter(nonNullable),
        // Sanitize request (trim query and filter)
        map(sanitizeRequest),
        // Only emit when values have changed
        distinctUntilChanged(isEqual),
        // Debounce requests
        debounce((request) => timer(request?.debounceTime || DEFAULT_DEBOUNCE_TIME)),
        // Trigger `onStart` callback
        tap(onStart),
        switchMap((request) => {
          return concat(
            // Emit loading start
            of({
              ...INITIAL_SEARCH_STATE,
              loading: true,
              options: request.options,
              terms: request.terms,
            }),
            // Conditionally trigger search ONLY if we have valid searchable terms.
            // Typically, search terms are valid if either query, filter or selected types is non-empty.
            // There are exceptions (e.g. searching within <AutoComplete> components) where empty queries are permitted,
            // which is what `allowEmptyQueries` is used for.
            iif(
              () => hasSearchableTerms({allowEmptyQueries, terms: request.terms}),
              // If we have a valid search, run async fetch, map results and trigger `onComplete` / `onError` callbacks
              search(request.terms, request.options).pipe(
                tap(({hits, nextCursor}) => onComplete?.({hits, nextCursor})),
                catchError((error) => {
                  onError?.(error)
                  return of({
                    ...INITIAL_SEARCH_STATE,
                    error,
                    loading: false,
                    options: request.options,
                    terms: request.terms,
                  })
                }),
              ),
              // If there is no valid search, emit an empty observable and trigger `onComplete` event
              of(EMPTY).pipe(tap(() => onComplete?.({hits: [], nextCursor: undefined}))),
            ),
            // Emit loading completed
            of({loading: false}),
          )
        }),
        scan((prevState, nextState): SearchState => {
          return {...prevState, ...nextState}
        }, INITIAL_SEARCH_STATE),
        // Update local search state
        tap(setSearchState),
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- @todo: add onComplete, onError and onStart to the deps list when it's verified that it's safe to do so
    [allowEmptyQueries, search],
  )

  const handleSearch = useCallback(
    (searchRequest: SearchRequest) => handleQueryChange(searchRequest),
    [handleQueryChange],
  )

  return {handleSearch, searchState}
}
