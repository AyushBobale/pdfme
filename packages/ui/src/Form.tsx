import React from 'react';
import { PreviewProps } from '@pdfme/common';
import { PreviewUI } from './class.js';
import { DESTROYED_ERR_MSG } from './constants.js';
import { I18nContext, FontContext } from './contexts.js';
import Preview from './components/Preview.js';

class Form extends PreviewUI {
  private onChangeInputCallback?: (arg: { index: number; value: string; key: string }) => void;

  constructor(props: PreviewProps) {
    super(props);
    this.render();
  }

  public onChangeInput(cb: (arg: { index: number; value: string; key: string }) => void) {
    this.onChangeInputCallback = cb;
  }

  protected render() {
    if (!this.domContainer || !this.root) throw Error(DESTROYED_ERR_MSG);
    this.root.render(
      <I18nContext.Provider value={this.getI18n()}>
        <FontContext.Provider value={this.getFont()}>
          <Preview
            template={this.template}
            size={this.size}
            inputs={this.inputs}
            onChangeInput={(arg: { index: number; value: string; key: string }) => {
              const { index, value, key } = arg;
              if (this.onChangeInputCallback) {
                this.onChangeInputCallback({ index, value, key });
              }
              this.inputs[index][key] = value;
              this.render();
            }}
          />
        </FontContext.Provider>
      </I18nContext.Provider>
    );
  }
}

export default Form;
