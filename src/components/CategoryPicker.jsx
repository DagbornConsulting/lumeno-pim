import { useState, useEffect, useRef, useMemo } from 'react';
import { Search, X, ChevronRight } from 'lucide-react';

export default function CategoryPicker({ value, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [categories, setCategories] = useState(null);
  const [topCategories, setTopCategories] = useState(null);
  const [expandedParent, setExpandedParent] = useState(null);
  const containerRef = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    if (isOpen && !categories) {
      import('../data/taxonomy.js').then(mod => {
        setCategories(mod.shopifyCategories);
        setTopCategories(mod.topCategories);
      });
    }
    if (isOpen && searchRef.current) {
      searchRef.current.focus();
    }
  }, [isOpen, categories]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const searchResults = useMemo(() => {
    if (!search.trim() || !categories) return [];
    const q = search.toLowerCase();
    return categories
      .filter(c => c.n.toLowerCase().includes(q) || c.p.toLowerCase().includes(q))
      .slice(0, 50);
  }, [search, categories]);

  const childCategories = useMemo(() => {
    if (!expandedParent || !categories) return [];
    return categories.filter(c => c.pi === expandedParent);
  }, [expandedParent, categories]);

  const selectedCategory = useMemo(() => {
    if (!value || !categories) return null;
    return categories.find(c => c.id === value);
  }, [value, categories]);

  const handleSelect = (cat) => {
    onChange(cat.id);
    setIsOpen(false);
    setSearch('');
    setExpandedParent(null);
  };

  const handleClear = (e) => {
    e.stopPropagation();
    onChange('');
  };

  const hasChildren = (parentId) => {
    if (!categories) return false;
    return categories.some(c => c.pi === parentId);
  };

  const displayValue = selectedCategory
    ? selectedCategory.p
    : value || '';

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <div
        className="form-input"
        onClick={() => setIsOpen(!isOpen)}
        style={{
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          minHeight: '38px',
          color: displayValue ? 'inherit' : 'var(--text-secondary)'
        }}
      >
        <Search size={14} style={{ flexShrink: 0, opacity: 0.5 }} />
        <span style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: '13px'
        }}>
          {displayValue || 'Sök eller välj produktkategori...'}
        </span>
        {value && (
          <button
            onClick={handleClear}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '2px', display: 'flex', color: 'var(--text-secondary)'
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {isOpen && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          marginTop: '4px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          zIndex: 1000,
          maxHeight: '400px',
          display: 'flex',
          flexDirection: 'column'
        }}>
          <div style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              background: 'var(--bg)', borderRadius: '6px',
              padding: '6px 10px', border: '1px solid var(--border)'
            }}>
              <Search size={14} style={{ opacity: 0.5 }} />
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={e => { setSearch(e.target.value); setExpandedParent(null); }}
                placeholder="Sök kategori..."
                style={{
                  border: 'none', background: 'none', outline: 'none',
                  flex: 1, fontSize: '13px', color: 'inherit'
                }}
              />
              {search && (
                <button onClick={() => setSearch('')}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', color: 'var(--text-secondary)' }}>
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {!categories ? (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
                Laddar kategorier...
              </div>
            ) : search.trim() ? (
              searchResults.length > 0 ? (
                searchResults.map(cat => (
                  <CategoryRow key={cat.id} cat={cat} onSelect={handleSelect} selectedId={value} showPath />
                ))
              ) : (
                <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
                  Inga kategorier matchar "{search}"
                </div>
              )
            ) : expandedParent ? (
              <>
                <button
                  onClick={() => {
                    const parent = categories.find(c => c.id === expandedParent);
                    setExpandedParent(parent?.pi || null);
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    padding: '8px 12px', fontSize: '12px', fontWeight: 600,
                    color: 'var(--accent)', cursor: 'pointer',
                    background: 'none', border: 'none', borderBottom: '1px solid var(--border)',
                    width: '100%', textAlign: 'left'
                  }}
                >
                  ← Tillbaka
                </button>
                {(() => {
                  const parent = categories.find(c => c.id === expandedParent);
                  return parent ? (
                    <CategoryRow cat={parent} onSelect={handleSelect} selectedId={value} showPath isParentOption />
                  ) : null;
                })()}
                {childCategories.map(cat => (
                  <CategoryRow
                    key={cat.id}
                    cat={cat}
                    onSelect={hasChildren(cat.id) ? () => setExpandedParent(cat.id) : handleSelect}
                    selectedId={value}
                    hasChildren={hasChildren(cat.id)}
                  />
                ))}
              </>
            ) : (
              topCategories?.map(cat => (
                <CategoryRow
                  key={cat.id}
                  cat={cat}
                  onSelect={hasChildren(cat.id) ? () => setExpandedParent(cat.id) : handleSelect}
                  selectedId={value}
                  hasChildren={hasChildren(cat.id)}
                />
              ))
            )}
          </div>

          {selectedCategory && (
            <div style={{
              padding: '8px 12px', borderTop: '1px solid var(--border)',
              fontSize: '11px', color: 'var(--text-secondary)',
              display: 'flex', justifyContent: 'space-between'
            }}>
              <span>Vald: {selectedCategory.n}</span>
              {selectedCategory.g && <span>Google ID: {selectedCategory.g}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CategoryRow({ cat, onSelect, selectedId, showPath, hasChildren, isParentOption }) {
  const isSelected = cat.id === selectedId;
  return (
    <div
      onClick={() => onSelect(cat)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        cursor: 'pointer',
        fontSize: '13px',
        background: isSelected ? 'var(--accent-dim)' : 'transparent',
        borderBottom: '1px solid var(--border-light, rgba(255,255,255,0.05))',
        fontWeight: isParentOption ? 600 : 'normal'
      }}
      onMouseEnter={e => !isSelected && (e.currentTarget.style.background = 'var(--surface-hover)')}
      onMouseLeave={e => !isSelected && (e.currentTarget.style.background = 'transparent')}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {isParentOption && (
          <div style={{ fontSize: '11px', color: 'var(--accent)', marginBottom: '2px' }}>
            Välj denna kategori
          </div>
        )}
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {showPath ? cat.p : cat.n}
        </div>
        {showPath && cat.g && (
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
            Google ID: {cat.g}
          </div>
        )}
      </div>
      {hasChildren && <ChevronRight size={14} style={{ opacity: 0.5, flexShrink: 0 }} />}
    </div>
  );
}
