import { useRef, useState, useEffect, useContext } from 'react';
import * as styles from './index.module.scss';
import { Template, Schema, TemplateEditorProp } from '../../type';
import Sidebar from './Sidebar';
import Main from './Main';
import { zoom, rulerHeight } from '../../constants';
import { I18nContext } from '../../i18n';
import {
  uuid,
  set,
  cloneDeep,
  debounce,
  round,
  b64toBlob,
  arrayMove,
  getPdfPageSizes,
  fmtTemplate,
  sortSchemas,
  getInitialSchema,
  initShortCuts,
  destroyShortCuts,
  getSampleByType,
  getKeepRaitoHeightByWidth,
} from '../../utils';
import { useUiPreProcessor } from '../../hooks';

const fmtValue = (key: string, value: string) => {
  const skip = ['id', 'key', 'type', 'data', 'alignment', 'fontColor', 'backgroundColor'];
  return skip.includes(key) ? value : Number(value) < 0 ? 0 : Number(value);
};

const TemplateEditor = ({ template, saveTemplate, Header, size }: TemplateEditorProp) => {
  const copiedSchemas = useRef<Schema[] | null>(null);
  const past = useRef<Schema[][]>([]);
  const future = useRef<Schema[][]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const basePdf = useRef('');

  const i18n = useContext(I18nContext);

  const { backgrounds, pageSizes, scale } = useUiPreProcessor({
    template,
    size,
    basePdf: basePdf.current,
    offset: rulerHeight + (headerRef.current?.clientHeight || 0),
  });

  const [processing, setProcessing] = useState<boolean>(false);
  const [focusElementId, setFocusElementId] = useState('');
  const [activeElements, setActiveElements] = useState<HTMLElement[]>([]);
  const [schemas, setSchemas] = useState<Schema[][]>([[]] as Schema[][]);
  const [pageCursor, setPageCursor] = useState(0);

  const modifiedTemplate = fmtTemplate(
    Object.assign(template, { basePdf: basePdf.current ? basePdf.current : template.basePdf }),
    schemas
  );

  const onScroll = debounce(() => {
    if (!pageSizes[0] || !wrapRef.current) {
      return;
    }

    const scroll = wrapRef.current.scrollTop;
    const top = wrapRef.current.getBoundingClientRect().top;
    const pageHeights = pageSizes.reduce((acc, cur, i) => {
      let value = cur.height * zoom * scale;
      if (i === 0) {
        value += top - value / 2;
      } else {
        value += acc[i - 1];
      }
      return acc.concat(value);
    }, [] as number[]);
    let _pageCursor = 0;
    pageHeights.forEach((ph, i) => {
      if (scroll > ph) {
        _pageCursor = i + 1 >= pageHeights.length ? pageHeights.length - 1 : i + 1;
      }
    });
    if (_pageCursor !== pageCursor) {
      setPageCursor(_pageCursor), onEditEnd();
    }
  }, 100);

  const initEvents = () => {
    wrapRef.current && wrapRef.current.addEventListener('scroll', onScroll);
    const getActiveSchemas = () => {
      const ids = activeElements.map((ae) => ae.id);
      return schemas[pageCursor].filter((s) => ids.includes(s.id));
    };
    const timeTavel = (mode: 'undo' | 'redo') => {
      const isUndo = mode === 'undo';
      if ((isUndo ? past : future).current.length <= 0) return;
      (isUndo ? future : past).current.push(cloneDeep(schemas[pageCursor]));
      const s = cloneDeep(schemas);
      s[pageCursor] = (isUndo ? past : future).current.pop()!;
      setSchemas(s), onEditEnd();
    };
    initShortCuts({
      move: (command, isShift) => {
        const ps = pageSizes[pageCursor];
        const activeSchemas = getActiveSchemas();
        const arg = activeSchemas.map((as) => {
          let key: 'x' | 'y' = 'x';
          let value = 0;
          const num = isShift ? 0.1 : 1;
          const { position, height, width } = as;
          switch (command) {
            case 'up': {
              key = 'y';
              value = round(position['y'] - num, 2);
              break;
            }
            case 'down': {
              key = 'y';
              value = round(position['y'] + num, 2);
              break;
            }
            case 'left':
              value = round(position['x'] - num, 2);
              break;
            case 'right':
              value = round(position['x'] + num, 2);
              break;
          }
          if (key === 'x') {
            value = value > ps.width - width ? ps.width - width : value;
          } else {
            value = value > ps.height - height ? ps.height - height : value;
          }
          return { key: `position.${key}`, value: String(value), schemaId: as.id };
        });
        changeSchema(arg);
      },
      remove: () => removeSchemas(getActiveSchemas().map((s) => s.id)),
      esc: onEditEnd,
      copy: () => {
        const activeSchemas = getActiveSchemas();
        if (activeSchemas.length === 0) return;
        copiedSchemas.current = activeSchemas;
      },
      paste: () => {
        if (!copiedSchemas.current || copiedSchemas.current.length === 0) return;
        const ps = pageSizes[pageCursor];
        const _schemas = copiedSchemas.current.map((cs) => {
          const { height, width, position: p } = cs;
          const position = {
            x: p.x + 10 > ps.width - width ? ps.width - width : p.x + 10,
            y: p.y + 10 > ps.height - height ? ps.height - height : p.y + 10,
          };
          const schema = Object.assign(cloneDeep(cs), { id: uuid(), position });
          schema.key = schema.key + ' copy';
          return schema;
        });
        commitSchemas(schemas[pageCursor].concat(_schemas));
        setActiveElements(_schemas.map((s) => document.getElementById(s.id)!));
        copiedSchemas.current = _schemas;
      },
      redo: () => timeTavel('redo'),
      undo: () => timeTavel('undo'),
      save: () => {
        setProcessing(true);
        saveTemplate(modifiedTemplate).then(() => setProcessing(false));
      },
    });
  };

  const destroyEvents = () => {
    wrapRef.current && wrapRef.current.removeEventListener('scroll', onScroll);
    destroyShortCuts();
  };

  useEffect(() => {
    updateTemplate(template);
  }, []);

  useEffect(() => {
    initEvents();
    return destroyEvents;
  }, [activeElements, schemas, template, size, pageSizes]);

  const addSchema = () => {
    const s = getInitialSchema();
    // TODO ここでpaperへdocument.getElementByIでアクセスしたくない
    const paper = document.getElementById(`paper-${pageCursor}`);
    const rectTop = paper ? paper.getBoundingClientRect().top : 0;
    // TODO マジックナンバー
    const headerHeight = 53;
    s.position.y = rectTop - headerHeight > 0 ? 0 : pageSizes[pageCursor].height / 2;
    s.data = 'text';
    s.key = `${i18n('field')}${schemas[pageCursor].length + 1}`;
    commitSchemas(schemas[pageCursor].concat(s));
    setTimeout(() => setActiveElements([document.getElementById(s.id)!]));
  };

  const removeSchemas = (ids: string[]) => {
    commitSchemas(schemas[pageCursor].filter((schema) => !ids.includes(schema.id)));
    onEditEnd();
  };

  const changeSchema = (obj: { key: string; value: string; schemaId: string }[]) => {
    const newSchemas = obj.reduce((acc, { key, value, schemaId }) => {
      const tgt = acc.find((s) => s.id === schemaId)!;
      // Assign to reference
      set(tgt, key, fmtValue(key, value));
      if (key === 'type') {
        // set default value, text or barcode
        set(tgt, 'data', value === 'text' ? 'text' : getSampleByType(value));
        // For barcodes, adjust the height to get the correct ratio.
        if (value !== 'text' && value !== 'image') {
          set(tgt, 'height', getKeepRaitoHeightByWidth(value, tgt.width));
        }
      }
      return acc;
    }, cloneDeep(schemas[pageCursor]));
    commitSchemas(newSchemas);
  };

  const commitSchemas = (newSchemas: Schema[]) => {
    future.current = [];
    past.current.push(cloneDeep(schemas[pageCursor]));
    const _schemas = cloneDeep(schemas);
    _schemas[pageCursor] = newSchemas;
    setSchemas(_schemas);
  };

  const onSortEnd = (arg: { oldIndex: number; newIndex: number }) => {
    const movedSchema = arrayMove(cloneDeep(schemas[pageCursor]), arg.oldIndex, arg.newIndex);
    commitSchemas(movedSchema);
  };

  const onEdit = (id: string) => setActiveElements([document.getElementById(id)!]);

  const onEditEnd = () => setActiveElements([]);

  const onMouseEnter = (id: string) => setFocusElementId(id);

  const onMouseLeave = () => setFocusElementId('');

  const updateTemplate = async (newTemplate: Template) => {
    const newSchemas = sortSchemas(newTemplate, newTemplate.schemas.length);
    basePdf.current = newTemplate.basePdf as string;
    const pdfBlob = b64toBlob(newTemplate.basePdf as string);
    const pageSizes = await getPdfPageSizes(pdfBlob);
    const _schemas = (
      newSchemas.length < pageSizes.length
        ? newSchemas.concat(new Array(pageSizes.length - newSchemas.length).fill(cloneDeep([])))
        : newSchemas.slice(0, pageSizes.length)
    ).map((schema, i) => {
      Object.values(schema).forEach((value) => {
        const { width, height } = pageSizes[i];
        const xEdge = value.position.x + value.width;
        const yEdge = value.position.y + value.height;
        if (width < xEdge) {
          const diff = xEdge - width;
          value.position.x += diff;
        }
        if (height < yEdge) {
          const diff = yEdge - height;
          value.position.y += diff;
        }
      });
      return schema;
    });
    setSchemas(_schemas);
    onEditEnd(), setFocusElementId(''), setPageCursor(0);
    wrapRef.current && wrapRef.current.scroll({ top: 0, behavior: 'smooth' });
  };

  const saveTemplateWithProcessing = async (template: Template) => {
    setProcessing(true);
    const _template = cloneDeep<any>(template);
    delete _template.pages;
    const tmplt = await saveTemplate(_template);
    setProcessing(false);
    return tmplt;
  };

  const getLastActiveSchema = () => {
    if (activeElements.length === 0) return getInitialSchema();
    const last = activeElements[activeElements.length - 1];
    return schemas[pageCursor].find((s) => s.id === last.id) || getInitialSchema();
  };

  const activeSchema = getLastActiveSchema();

  return (
    <div ref={wrapRef} className={`${styles.root}`} style={{ ...size }}>
      <div ref={headerRef}>
        <Header
          processing={processing}
          template={modifiedTemplate}
          saveTemplate={saveTemplateWithProcessing}
          updateTemplate={updateTemplate}
        />
      </div>
      <div className={`${styles.wrapper}`}>
        <Sidebar
          pageCursor={pageCursor}
          activeElement={activeElements[activeElements.length - 1]}
          schemas={schemas[pageCursor]}
          focusElementId={focusElementId}
          activeSchema={activeSchema}
          changeSchema={changeSchema}
          onSortEnd={onSortEnd}
          onEdit={onEdit}
          onEditEnd={onEditEnd}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
          addSchema={addSchema}
          removeSchema={(id) => removeSchemas([id])}
        />
        <Main
          pageCursor={pageCursor}
          scale={scale}
          pageSizes={pageSizes}
          backgrounds={backgrounds}
          activeElements={activeElements}
          focusElementId={focusElementId}
          schemas={schemas}
          changeSchema={changeSchema}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
          onSelectSchemas={setActiveElements}
        />
      </div>
    </div>
  );
};

export default TemplateEditor;
