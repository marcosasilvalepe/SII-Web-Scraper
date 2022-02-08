const waitForUserInput = require('wait-for-user-input');
const puppeteer = require('puppeteer');
const mysql = require('mysql');
const sii_url = 'https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html?https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi?DESDE_DONDE_URL=OPCION%3D52%26TIPO%3D4';

const conn = mysql.createConnection({ 
    host: "localhost",
    port: 3306,
    user: "root", 
    password: "", 
    database: "romana" 
});

const thousand_separator = num => { return num.toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1.') }

const get_weight_data = weight => {
    return new Promise((resolve, reject) => {
        conn.query(`
            SELECT weights.status, cycles.name AS cycle, drivers.rut AS driver_rut, drivers.name AS driver_name, 
            weights.primary_plates, transport.rut AS transport_rut, transport.name AS transport_name
            FROM weights
            INNER JOIN cycles ON weights.cycle=cycles.id
            INNER JOIN drivers ON weights.driver_id=drivers.id
            LEFT OUTER JOIN entities transport ON weights.transport_id=transport.id
            WHERE weights.id=${weight};
        `, (error, results, fields) => {
            
            if (error || results.length === 0) return reject(error);
            if (results[0].status === 'N') return reject(`Estado del pesaje Nº ${weight} es NULO`);

            return resolve({
                Numero: weight,
                Ciclo: results[0].cycle,
                Estado: (results[0].status === 'I') ? 'En Proceso' : 'Terminado',
                Patente: results[0].primary_plates,
                Chofer: {
                    Nombre: results[0].driver_name,
                    RUT: results[0].driver_rut
                },
                Transportista: {
                    Nombre: results[0].transport_name,
                    RUT: results[0].transport_rut
                }
            });
        })
    })
}

const get_weight_documents = weight => {
    return new Promise((resolve, reject) => {
        conn.query(`

            SELECT header.id, header.date, header.document_total, header.sale, internal_entities.name AS internal_name, internal_entities.rut AS internal_rut, internal_branches.name AS internal_branch, 
            entity.rut AS destination_rut, entity.name AS destination_name, branch.name AS destination_branch_name, 
            branch.address AS destination_branch_address, comunas.comuna AS destination_branch_comuna
            
            FROM documents_header header

            INNER JOIN weights ON header.weight_id=weights.id
            INNER JOIN entities entity ON header.client_entity=entity.id
            INNER JOIN entity_branches branch ON header.client_branch=branch.id

            INNER JOIN internal_entities ON header.internal_entity=internal_entities.id
            INNER JOIN internal_branches ON header.internal_branch=internal_branches.id
            
            INNER JOIN comunas ON branch.comuna=comunas.id
            INNER JOIN drivers ON weights.driver_id=drivers.id
            WHERE weights.id=${parseInt(weight)} AND (header.status='I' OR header.status='T');

        `, (error, results, fields) => {
            
            if (error) return reject(error);
            if (results.length === 0) return reject(`No se pudo encontrar datos asociados al pesaje Nº ${weight}.`);
            if (results[0].weight_status === 'N') return reject(`El estado del pesaje Nº ${weight}  es NULO`);

            return resolve(results);
        })
    })
}

const get_document_rows = doc_id => {
    return new Promise((resolve, reject) => {

        conn.query(`
            SELECT body.product_code, products.name AS product_name, body.cut AS descarte, body.price, body.kilos, body.container_code, containers.name AS container_name, body.container_amount
            FROM documents_body body
            LEFT OUTER JOIN products ON body.product_code=products.code
            LEFT OUTER JOIN containers ON body.container_code=containers.code
            WHERE body.document_id=${parseInt(doc_id)} AND (body.status='T' OR body.status='I');
        `, (error, results, fields) => {
            if (error) return reject(error);
            
            const rows = [];
            for (let i = 0; i < results.length; i++) {

                rows.push({
                    Producto: (results[i].product_code === null) ? null : results[i].product_name.toUpperCase() + ' DESCARTE ' + results[i].descarte.toUpperCase(),
                    Precio: (results[i].product_code === null) ? null : results[i].price,
                    Kilos: results[i].kilos,
                    Nombre_Envase: (results[i].container_code === null) ? null : results[i].container_name.toUpperCase(),
                    Cantidad_Envases: (results[i].container_code !== null && 1 * results[i].container_amount > 0) ? results[i].container_amount : null 
                });
                
            }

            return resolve(rows);

        })
    })
}

const get_sii_credentials = rut => {
    return new Promise((resolve, reject) => {
        conn.query(`
            SELECT dte_user, dte_pass, dte_firm FROM internal_entities WHERE rut=${conn.escape(rut)};
        `, (error, results, fields) => {
            
            if (error) return reject(error);
            if (results.length === 0) return reject('No se pudo encontrar Usuario y Clave de SII para entidad interna seleccionada en documento.');
            if (results[0].dte_user === null || results[0].dte_pass === null || results[0].dte_firm === null) return reject('Usuario y/o Clave de SII para entidad interna están vacíos.');

            global.dte = {
                user: results[0].dte_user,
                password: results[0].dte_pass,
                firm: results[0].dte_firm
            }

            return resolve();
        })
    })
}

const delay = ms => { return new Promise(resolve => { setTimeout(resolve, ms) }) }

async function waitForEvent(page, event, timeout = 35000) {
    return Promise.race([
        page.evaluate(
            event => new Promise(resolve => document.querySelector('#collapseRECEPTOR select[name="EFXP_GIRO_RECEP"]').addEventListener(event, resolve, { once: true })),
            event
        ),
        page.waitForTimeout(timeout)
    ]);
}

const go_to_sii = () => {
    return new Promise(async (resolve, reject) => {
        try {
            const browser = await puppeteer.launch({headless: false}); // default is true
            const page = await browser.newPage();
            
            page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.162 Safari/537.36');
            console.log("cargando página principal...\r\n");
            await page.goto(sii_url);
    
            //LOGIN BUTTON
            await page.waitForSelector('#bt_ingresar');
    
            await page.focus('#rutcntr');
            await page.keyboard.type(global.dte.user);
            await page.focus('#clave');
            await page.keyboard.type(global.dte.password);
    
            await Promise.all([
                page.click('#bt_ingresar'),
                console.log('Esperando a que la página termine de cargar...\r\n'),
                page.waitForNavigation({ 
                    waitUntil: 'networkidle2', 
                    timeout: 45000 
                }),
            ]);
    
            console.log('Usuario y Clave ingresado correctamente. Ingresando datos encabezado...\r\n');
            
            //CONSTITUTES SALE SELECT
            if (!global.document.Constituye_Venta) await page.select('#collapseEMISOR select[name="EFXP_IND_VENTA"]', '6');
    
            //DESTINATION RUT
            const 
            client_rut = global.document.Rut_Entidad_Destino.split('-'),
            client_digits = client_rut[0].replace(/[.]/gm, ''),
            client_dv = client_rut[1];
    
            await page.focus('#collapseRECEPTOR input[name="EFXP_RUT_RECEP"]');
            await page.keyboard.type(client_digits);
            await page.keyboard.press('Tab');
            await page.keyboard.type(client_dv);
            await page.keyboard.press('Tab');
    
            await page.waitForNavigation({ 
                waitUntil: 'networkidle2', 
                timeout: 5000 
            });

            //DESTINATION CITY -> NEEDS TO BE AFTER DESTINATION RUT INPUT
            await page.evaluate( () => { document.querySelector('#collapseEMISOR input[name="EFXP_CIUDAD_ORIGEN"]').value = '' });
            await page.focus('#collapseEMISOR input[name="EFXP_CIUDAD_ORIGEN"]');
            await page.keyboard.type(global.document.Comuna_Sucursal_Destino.toUpperCase());

            //CHANGE DOCUMENT DATE
            const
            document_date = global.document.Fecha_Documento.split('-'),
            document_day = document_date[0],
            document_month = document_date[1];
    
            await page.waitForSelector('#collapseEMISOR select[name="cbo_dia_boleta"]');
            await page.select('#collapseEMISOR select[name="cbo_dia_boleta"]', document_day);
            await page.select('#collapseEMISOR select[name="cbo_mes_boleta"]', document_month);
    
            //DESTINATION CITY
            await page.waitForSelector('#collapseRECEPTOR input[name="EFXP_CIUDAD_RECEP"]');
            await page.focus('#collapseRECEPTOR input[name="EFXP_CIUDAD_RECEP"]');
            await page.keyboard.type(global.document.Comuna_Sucursal_Destino);
            

            //VEHICLE DATA
            if (await page.evaluate('document.getElementById("EFXP_RUT_TRANSPORTE")')) {
    
                const 
                driver_rut_split = global.weight.Chofer.RUT.split('-'),
                driver_rut_digits = driver_rut_split[0].replace(/[.]/gm, ''),
                driver_rut_dv = driver_rut_split[1];
    
                await page.focus('#EFXP_RUT_TRANSPORTE');
                await page.keyboard.type('77686780');
                await page.keyboard.press('Tab');
                await page.keyboard.type('2');
                await page.keyboard.press('Tab');
                await page.keyboard.type(global.weight.Patente);
                await page.keyboard.press('Tab');
                await page.keyboard.type(driver_rut_digits);
                await page.keyboard.press('Tab');
                await page.keyboard.type(driver_rut_dv);
                await page.keyboard.press('Tab');
                await page.keyboard.type(global.weight.Chofer.Nombre);
    
            }
            else { 
    
                console.log('Transport div not found... Adding data to text area instead...\r\n');
                await page.keyboard.press('Enter');
                await page.keyboard.type('PATENTE VEHICULO: ' + global.weight.Patente);
                await page.keyboard.press('Enter');
                await page.keyboard.type('CHOFER: ' + global.weight.Chofer.Nombre);
                await page.keyboard.press('Enter');
                await page.keyboard.type('RUT CHOFER: ' + global.weight.Chofer.RUT);

            }
    
            console.log('Datos de encabezado ingresados correctamente. Ingresando Detalle...\r\n');

            const rows = global.document.Cuerpo_Documento;

            //CHECK IF DOCUMENT HAS PRODUCTS IN ANY OF THE ROWS. IF IT DOESNT THEN IT'S TRANSPORT GUIDE ONLY (NO SALE)
            let document_with_products = false;
            for (let i = 0; i < rows.length; i++) {
                if (rows[i].Producto !== null) {
                    document_with_products = true;
                    break;
                }
            }

            //ADD DOCUMENT BODY DETAILS
            for (let i = 0; i < rows.length; i++) {
                
                //CLICK ON BUTTON TO ADD NEW LINE IF IT ISN'T THE FIRST ONE
                if (i > 0) {
                    await page.click(`#rowDet_Botones input[name="AGREGA_DETALLE"]`);
                    await page.waitForSelector(`#rowDet_0${i + 1}`);
                }

                //EMPTY CONTAINERS
                if (rows[i].Producto === null) {

                    //CONTAINER NAME
                    await page.focus(`#myTable input[name="EFXP_NMB_0${i + 1}"]`);
                    await page.keyboard.type(rows[i].Nombre_Envase.split(' ')[0]);

                    //CLICK ON ADD LONGER DESCRIPTION CHECKBOX
                    await page.click(`#myTable input[name="DESCRIP_0${i + 1}"]`);
                    await page.waitForSelector(`#rowDescripcion_0${i + 1} textarea`);

                    //CONTAINER FULL DESCRIPTION
                    await page.focus(`#rowDescripcion_0${i + 1} textarea`);
                    await page.keyboard.type(rows[i].Nombre_Envase + ' - VACIO');

                    //CONTAINER AMOUNT
                    await page.focus(`#myTable input[name="EFXP_QTY_0${i + 1}"]`);
                    await page.keyboard.type(rows[i].Cantidad_Envases.toString());

                    //CONTAINER UNIT
                    await page.focus(`#myTable input[name="EFXP_UNMD_0${i + 1}"]`);
                    await page.keyboard.type('UN');

                    //CONTAINER PRICE -> 1 FOR EMPTY
                    await page.focus(`#myTable input[name="EFXP_PRC_0${i + 1}"]`);
                    await page.keyboard.type('1');

                }

                //CONTAINER WITH PRODUCT
                else {

                    //ON SHORT DESCRIPTION WRITE PRODUCT TYPE ONLY
                    await page.waitForSelector(`#myTable input[name="EFXP_NMB_0${i + 1}"]`);
                    await page.focus(`#myTable input[name="EFXP_NMB_0${i + 1}"]`);
                    await page.keyboard.type(rows[i].Producto.split(' ')[0]);

                    //CLICK ON ADD LONGER DESCRIPTION CHECKBOX
                    await page.click(`#myTable input[name="DESCRIP_0${i + 1}"]`);
                    
                    //WRITE FULL DESCRIPTION
                    await page.waitForSelector(`#rowDescripcion_0${i + 1} textarea`);
                    await page.focus(`#rowDescripcion_0${i + 1} textarea`);
                    await page.keyboard.type(rows[i].Producto);

                    //WRITE CONTAINER AMOUNT
                    await page.keyboard.press('Enter');
                    await page.keyboard.type(rows[i].Cantidad_Envases + ' ' + rows[i].Nombre_Envase);

                    //PRODUCT AMOUNT
                    if (1 * rows[i].Kilos === 0) throw `Error. Kilos de ${rows[i].Producto} es 0. ¿ Faltará hacer el desgloce de kilos ?`
                    await page.focus(`#myTable input[name="EFXP_QTY_0${i + 1}"]`);
                    await page.keyboard.type(rows[i].Kilos.toString());

                    //PRODUCT UNIT
                    await page.focus(`#myTable input[name="EFXP_UNMD_0${i + 1}"]`);
                    
                    if (rows[i].Producto.includes('UVA') || rows[i].Producto.includes('PASAS')) await page.keyboard.type('KG');
                    else await page.keyboard.type('UN');

                    //PRICE PRICE
                    await page.focus(`#myTable input[name="EFXP_PRC_0${i + 1}"]`);
                    await page.keyboard.type(rows[i].Precio.toString());

                }

                await page.keyboard.press('Tab');

                //SELECT GIRO
                const select_giro = () => {
                    return new Promise(async (resolve, reject) => {
                        try {
                            await page.evaluate(() => {
                                alert('Selecciona el giro');
                                const select = document.querySelector('#collapseRECEPTOR select[name="EFXP_GIRO_RECEP"]');
                                select.scrollIntoView();
                                select.focus();
                            });
                            await page.keyboard.press('Space');
                            return resolve();
                        } catch(error) { return reject(error); }
                    })
                }
                
                const check_giro = async () => {
                    return await page.evaluate(() => {
                        return new Promise(resolve => {

                            const 
                            select = document.querySelector('#collapseRECEPTOR select[name="EFXP_GIRO_RECEP"]'),
                            giro = select.options[select.selectedIndex].innerText;

                            const giro_is_correct = confirm(`Giro Seleccionado: ${giro}`);

                            if (giro_is_correct) return resolve(true);
                            return resolve(false);
                        })
                    })
                }

                //DO WHILE GIRO IS NOT CORRECT
                let giro_is_correct = false;
                while (!giro_is_correct) {

                    //SHOW AVAILABLE GIROS TO USER
                    await select_giro();

                    //WAIT FOR GIRO TO BE SELECTED FROM OPTIONS
                    await waitForEvent(page, 'change');
                    giro_is_correct = await check_giro();
                }

                console.log('Giro seleccionado correctamente...\r\n');

                //IF DOCUMENT HAS PRODUCTS CHECK IF TOTAL NET MATCHES
                if (document_with_products) {

                    const check_sii_doc_total = async () => {
                        return await page.evaluate(() => {
                            return new Promise(resolve => {
                                resolve(document.querySelector('input[name="EFXP_MNT_NETO"]').value);
                            })
                        })
                    }

                    const sii_doc_total = parseInt(await check_sii_doc_total());
                    if (sii_doc_total !== global.document.Total_Documento) {

                        console.log(`Total Neto no coincide en Servicio de Impuestos Internos.\r\n`);
                        console.log(`Total Doc.: $${thousand_separator(global.document.Total_Documento)}`);
                        console.log(`Total SII: $${thousand_separator(sii_doc_total)}\r\n`);

                        //CHECK IF IT SHOULD CONTINUE DESPITE DIFFERENCE IN SII
                        let continue_anyaway = await waitForUserInput('\n¿ Son correctos los datos ? [ s = SI / n = NO / e = EXIT]\n');
                        continue_anyaway = continue_anyaway.toLowerCase().substring(0, 1);

                        if (continue_anyaway === 'n' || continue_anyaway === 'e') {
                            console.log('Programa Terminado');
                            return resolve();
                        }
                    }
                }

                //PROCEED TO VISUALIZE DOCUMENT
                await page.click('button[name="Button_Update"]');


                //PROCEED TO SIGN PAGE
                await page.waitForSelector('input.btn.btn-default[name="btnSign"]');
                await page.click('input.btn.btn-default[name="btnSign"]');
                await page.waitForNavigation({ 
                    waitUntil: 'networkidle2',
                    timeout: 45000 
                });


                //SIGN PAGE -> WRITE SIGN PASSWORD
                await page.waitForSelector('#myPass');
                await page.focus('#myPass');
                await page.keyboard.type(global.dte.firm);

                await page.waitForSelector('#btnFirma');
                await page.click('#btnFirma');

                console.log('Documento Firmado correctamente\r\n');

                //CLICK ON DOWNLOAD PDF
                await page.waitForSelector('div.web-sii.cuerpo a.btn.btn-default[target="_blank"]');
                await page.click('div.web-sii.cuerpo a.btn.btn-default[target="_blank"]');

                console.log('Finished. Click to download file');
            }

        } catch(e) { console.log(e); return reject() }
    })
}


const globlal = {};

//START FUNCTION
(async () => {
    
    try {

        const 
        weight_input = await waitForUserInput('Ingresar numero de pesaje: \r\n'),
        weight = weight_input.replace(/\D/gm, ''),
        weight_object = await get_weight_data(weight);
        
        const 
        weight_documents = await get_weight_documents(weight),
        documents = [];
        
        for (let i = 0; i < weight_documents.length; i++) {
            documents.push({
                Linea_Documento: i + 1,
                ID: weight_documents[i].id,
                Fecha_Documento: weight_documents[i].date.toLocaleString('es-CL').split(' ')[0],
                Total_Documento: (weight_documents[i].document_total === null) ? 0 : thousand_separator(weight_documents[i].document_total),
                Constituye_Venta: (weight_documents[i].sale === 0) ? false : true,
                Entidad_Interna: {
                    Nombre: weight_documents[i].internal_name,
                    RUT: weight_documents[i].internal_rut,
                    Sucursal: weight_documents[i].internal_branch
                },
                Nombre_Entidad_Destino: weight_documents[i].destination_name,
                Rut_Entidad_Destino: weight_documents[i].destination_rut,
                Sucursal_Destino: weight_documents[i].destination_branch_name,
                Direccion_Sucursal_Destino: weight_documents[i].destination_branch_address,
                Comuna_Sucursal_Destino: weight_documents[i].destination_branch_comuna
            });
        }

        console.log('DATOS PESAJE:\n', weight_object);

        let weight_data_is_correct = await waitForUserInput('\n¿ Son correctos los datos ? [ s = SI / n = NO / e = EXIT]\r\n');
        weight_data_is_correct = weight_data_is_correct.toLowerCase().substring(0, 1);;

        //HANDLE CORRECT INPUT FROM USER
        while (weight_data_is_correct !== 's') {

            if (weight_data_is_correct !== 'n' && weight_data_is_correct !== 's' && weight_data_is_correct !== 'e') {

                console.log('Opción no valida. Prueba de nuevo.\r\n');
                console.log(weight_object, '\n');
    
                weight_data_is_correct = await waitForUserInput('¿ Son correctos los datos ? [ s = SI / n = NO / e = EXIT]\r\n');
                weight_data_is_correct = weight_data_is_correct.toLowerCase().substring(0, 1);

            } else {

                if (weight_data_is_correct === 'n') {
                    console.log('Ejecuta el script de nuevo con el número de pesaje correcto.');
                    process.exit();
                } else if (weight_data_is_correct === 'e') {
                    console.log('Programa Terminado');
                    process.exit();
                }
            }
        }

        let doc_index;
        if (documents.length === 1) doc_index = 0;
        else {
            const document_line = await waitForUserInput('Ingresa el número de Línea del Documento:\r\n');
            doc_index = parseInt(document_line.replace(/\D/gm), '') - 1;
        }

        global.weight = weight_object;
        global.document = documents[doc_index];
        global.document.Cuerpo_Documento = await get_document_rows(global.document.ID);

        if (global.document.Cuerpo_Documento.length > 9) throw 'Demasiadas lineas en detalle de documento. Máximo permitido es 10. Elimina filas de detalle en documento y prueba de nuevo.';

        console.log('DOCUMENTO SELECCIONADO:\r\n', global.document);

        let document_is_correct = await waitForUserInput('¿ Son correctos los datos del Documento ? [ s = SI / n = NO / e = EXIT]\r\n');
        document_is_correct = document_is_correct.toLowerCase().substring(0, 1);

        console.log('Abriendo Google Chrome...');

        await get_sii_credentials(global.document.Entidad_Interna.RUT);

        console.log(global.dte);
        await go_to_sii();

    }
    catch(e) { console.log(`Error. ${e}`) }
    finally { process.exit() }
})();
